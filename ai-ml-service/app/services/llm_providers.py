"""
Provider-agnostic LLM caller used by the roadmap generator and the resume
parser's free-text reasoning steps.

Mirrors the Node/Express backend's fallback strategy (backend/server.js):
try providers in AI_PROVIDER_ORDER, skip any without a configured key, retry
transient failures with backoff, and raise a clear error only if every
configured provider failed.
"""
import asyncio
import json
import logging
import time
from typing import Optional

import httpx

from app.config import get_settings

logger = logging.getLogger("ai_ml_service.llm")

settings = get_settings()

_cache: dict[str, tuple[float, str]] = {}


class LLMError(Exception):
    def __init__(self, message: str, provider_errors: Optional[dict] = None):
        super().__init__(message)
        self.provider_errors = provider_errors or {}


def _cache_key(system: str, user: str, opts: dict) -> str:
    return json.dumps({"s": system, "u": user, "o": opts}, sort_keys=True)


def _configured_providers() -> list[str]:
    available = {
        "groq": bool(settings.GROQ_API_KEY),
        "gemini": bool(settings.GEMINI_API_KEY),
    }
    return [p for p in settings.AI_PROVIDER_ORDER if available.get(p)]


# Groq exposes an OpenAI-compatible Chat Completions API, so this helper (originally shared
# with a real OpenAI provider) is reused for Groq's request/response shape.
async def _call_openai_compatible(client: httpx.AsyncClient, base_url: str, api_key: str, model: str,
                                   system: str, user: str, opts: dict) -> str:
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_tokens": opts.get("maxTokens", 1024),
        "temperature": opts.get("temperature", 0.4),
    }
    if opts.get("jsonMode"):
        body["response_format"] = {"type": "json_object"}
    resp = await client.post(
        f"{base_url}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "content-type": "application/json"},
        json=body,
        timeout=settings.AI_REQUEST_TIMEOUT_S,
    )
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"]


async def _call_gemini(client: httpx.AsyncClient, system: str, user: str, opts: dict) -> str:
    model = settings.GEMINI_MODEL
    # Google migrated Gemini API keys from the old `AIza...` format to a new `AQ....` format
    # (fully enforced as of Sept 2026); new-format keys must be sent via the `x-goog-api-key`
    # header rather than the old `?key=` query param, which now returns an auth error for them.
    resp = await client.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": settings.GEMINI_API_KEY},
        json={
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "maxOutputTokens": opts.get("maxTokens", 1024),
                "temperature": opts.get("temperature", 0.4),
                **({"responseMimeType": "application/json"} if opts.get("jsonMode") else {}),
            },
        },
        timeout=settings.AI_REQUEST_TIMEOUT_S,
    )
    resp.raise_for_status()
    data = resp.json()
    parts = data["candidates"][0]["content"]["parts"]
    return "".join(p.get("text", "") for p in parts)


async def call_llm(system: str, user: str, opts: Optional[dict] = None) -> dict:
    """
    Returns {"text": str, "provider": str} or raises LLMError.
    opts: {maxTokens, temperature, jsonMode, noCache, provider (force one)}
    """
    opts = opts or {}
    if len(system) + len(user) > settings.MAX_PROMPT_CHARS:
        raise LLMError(f"Prompt exceeds MAX_PROMPT_CHARS ({settings.MAX_PROMPT_CHARS})")

    key = _cache_key(system, user, opts)
    if not opts.get("noCache"):
        hit = _cache.get(key)
        if hit and (time.time() - hit[0]) < settings.CACHE_TTL_S:
            return {"text": hit[1], "provider": "cache"}

    forced = opts.get("provider")
    providers = [forced] if forced else _configured_providers()
    if not providers:
        raise LLMError(
            "No LLM provider is configured. Set GROQ_API_KEY or GEMINI_API_KEY in ai-ml-service/.env"
        )

    errors: dict[str, str] = {}
    async with httpx.AsyncClient() as client:
        for provider in providers:
            for attempt in range(settings.AI_MAX_RETRIES + 1):
                try:
                    if provider == "groq":
                        text = await _call_openai_compatible(
                            client, "https://api.groq.com/openai/v1", settings.GROQ_API_KEY,
                            settings.GROQ_MODEL, system, user, opts)
                    elif provider == "gemini":
                        text = await _call_gemini(client, system, user, opts)
                    else:
                        break
                    _cache[key] = (time.time(), text)
                    return {"text": text, "provider": provider}
                except Exception as exc:  # noqa: BLE001 - deliberately broad, we fall back
                    errors[f"{provider}#{attempt}"] = str(exc)
                    logger.warning("LLM provider %s attempt %s failed: %s", provider, attempt, exc)
                    if attempt < settings.AI_MAX_RETRIES:
                        await asyncio.sleep(0.6 * (2 ** attempt))
    raise LLMError("All configured LLM providers failed.", provider_errors=errors)


def parse_json_loose(text: str) -> dict:
    """Best-effort JSON parse: strips markdown fences and finds the outermost {...}."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(cleaned[start:end + 1])
        raise
