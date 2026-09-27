"""
Central configuration for the AI/ML Intelligence Service.

Every value has a safe default so the service boots even with an empty
.env, but AI-backed endpoints will clearly report which provider key is
missing rather than failing silently.
"""
import os
from functools import lru_cache

try:
    from dotenv import load_dotenv
    load_dotenv()
    _DOTENV_LOADED = True
except ImportError:
    # python-dotenv is a dev convenience; the service still works if the
    # real environment variables are injected by the host (Docker, Render, etc).
    # BUGFIX: this used to fail silently, which meant a developer with keys sitting
    # in .env but no dotenv package installed would see the startup warning claim
    # "no LLM provider key configured" with no clue why. main.py now surfaces this
    # explicitly via settings.DOTENV_LOADED.
    _DOTENV_LOADED = False


def _bool(name: str, default: bool) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


class Settings:
    # --- Service ---
    DOTENV_LOADED: bool = _DOTENV_LOADED
    SERVICE_NAME: str = "campus-ai-ml-service"
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = _int("PORT", 8000)
    ENV: str = os.getenv("ENV", "development")
    CORS_ORIGINS: list = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]

    # --- LLM providers (mirrors backend/server.js so the same keys can be reused) ---
    # Groq is tried first; if it fails (missing key, error, timeout, rate limit, etc.) the
    # request automatically shifts to Gemini. Override via env.
    AI_PROVIDER_ORDER: list = [p.strip() for p in os.getenv("AI_PROVIDER_ORDER", "groq,gemini").split(",") if p.strip()]
    # .strip() guards against copy-pasted keys picking up stray quotes/whitespace from .env,
    # which otherwise surfaces as a confusing "invalid authentication credentials" error.
    GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "").strip()
    # llama-3.3-70b-versatile was decommissioned by Groq (Aug 16, 2026).
    # Recommended replacement: openai/gpt-oss-120b. https://console.groq.com/docs/deprecations
    GROQ_MODEL: str = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "").strip()
    GEMINI_MODEL: str = os.getenv("GEMINI_MODEL", "gemini-flash-latest")

    AI_REQUEST_TIMEOUT_S: int = _int("AI_REQUEST_TIMEOUT_S", 30)
    AI_MAX_RETRIES: int = _int("AI_MAX_RETRIES", 2)

    # --- Whisper (speech-to-text for mock interviews) ---
    WHISPER_PROVIDER: str = os.getenv("WHISPER_PROVIDER", "groq")  # groq | local
    WHISPER_MODEL: str = os.getenv("WHISPER_MODEL", "whisper-1")
    LOCAL_WHISPER_MODEL_SIZE: str = os.getenv("LOCAL_WHISPER_MODEL_SIZE", "base")

    # --- Vector store / semantic matching ---
    VECTOR_BACKEND: str = os.getenv("VECTOR_BACKEND", "faiss")  # faiss | qdrant | pinecone
    EMBEDDING_MODEL: str = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
    EMBEDDING_DIM: int = _int("EMBEDDING_DIM", 384)
    FAISS_INDEX_PATH: str = os.getenv("FAISS_INDEX_PATH", "./data/faiss_index")
    QDRANT_URL: str = os.getenv("QDRANT_URL", "http://localhost:6333")
    QDRANT_API_KEY: str = os.getenv("QDRANT_API_KEY", "")
    QDRANT_COLLECTION: str = os.getenv("QDRANT_COLLECTION", "campus_skills")
    PINECONE_API_KEY: str = os.getenv("PINECONE_API_KEY", "")
    PINECONE_ENV: str = os.getenv("PINECONE_ENV", "")
    PINECONE_INDEX: str = os.getenv("PINECONE_INDEX", "campus-skills")

    # --- Caching / limits ---
    CACHE_TTL_S: int = _int("CACHE_TTL_S", 600)
    MAX_UPLOAD_MB: int = _int("MAX_UPLOAD_MB", 10)
    MAX_PROMPT_CHARS: int = _int("MAX_PROMPT_CHARS", 24000)

    # --- Postgres (optional persistence for parsed profiles / roadmaps) ---
    DATABASE_URL: str = os.getenv("DATABASE_URL", "")  # e.g. postgresql://user:pass@host/db — leave blank to run in-memory only

    # --- Privacy ---
    PII_REDACTION: bool = _bool("PII_REDACTION_ENABLED", True)
    DATA_RETENTION_DAYS: int = _int("DATA_RETENTION_DAYS", 30)

    # --- Adaptive Skill Diagnostic Engine ---
    ADAPTIVE_MAX_QUESTIONS: int = _int("ADAPTIVE_MAX_QUESTIONS", 12)
    ADAPTIVE_MIN_QUESTIONS: int = _int("ADAPTIVE_MIN_QUESTIONS", 5)
    ADAPTIVE_SE_THRESHOLD: float = float(os.getenv("ADAPTIVE_SE_THRESHOLD", "0.45"))  # stop early once this precise
    ADAPTIVE_SESSION_TTL_S: int = _int("ADAPTIVE_SESSION_TTL_S", 3600)

    # --- AI Mock Interviewer — NLP / speech analysis ---
    INTERVIEW_SESSION_TTL_S: int = _int("INTERVIEW_SESSION_TTL_S", 3600)
    INTERVIEW_MAX_FOLLOWUPS: int = _int("INTERVIEW_MAX_FOLLOWUPS", 4)

    # --- Skill Gap & Market Intelligence Radar ---
    # Live job-market data is optional. Without keys, the radar runs entirely off the curated
    # dataset in data/market_skills.json (refreshed by hand / by a scheduled job you control),
    # so the feature always works offline/in a judging room with zero external calls.
    # BUGFIX: this used to require BOTH the provider name AND its key(s) to be set
    # separately (MARKET_LIVE_PROVIDER=adzuna *and* ADZUNA_APP_ID/KEY), so a developer
    # who only added API keys — the natural thing to do — still got the offline/cached
    # radar with no indication why, i.e. "not truly live by default". MARKET_LIVE_PROVIDER
    # can still be set explicitly to force/override a choice, but now defaults to
    # auto-detecting from whichever keys are actually present (Adzuna preferred, since it
    # has a free tier with no per-request cost).
    ADZUNA_APP_ID: str = os.getenv("ADZUNA_APP_ID", "")
    ADZUNA_APP_KEY: str = os.getenv("ADZUNA_APP_KEY", "")
    ADZUNA_COUNTRY: str = os.getenv("ADZUNA_COUNTRY", "in")
    JSEARCH_RAPIDAPI_KEY: str = os.getenv("JSEARCH_RAPIDAPI_KEY", "")

    @property
    def MARKET_LIVE_PROVIDER(self) -> str:  # "" | "adzuna" | "jsearch"
        explicit = os.getenv("MARKET_LIVE_PROVIDER", "").strip().lower()
        if explicit:
            return explicit
        if self.ADZUNA_APP_ID and self.ADZUNA_APP_KEY:
            return "adzuna"
        if self.JSEARCH_RAPIDAPI_KEY:
            return "jsearch"
        return ""
    MARKET_CACHE_TTL_S: int = _int("MARKET_CACHE_TTL_S", 21600)  # 6h — live results cached this long
    MARKET_DATA_PATH: str = os.getenv("MARKET_DATA_PATH", "./data/market_skills.json")


@lru_cache
def get_settings() -> "Settings":
    return Settings()

# --- Trusted backend gateway ---
AI_SERVICE_TOKEN: str = os.getenv("AI_ML_SERVICE_TOKEN", "").strip()
