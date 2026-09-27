"""
Speech-to-text for the Mock Interview flow.

The existing frontend already has browser SpeechRecognition (Chrome/Edge
only, no server round-trip). This service adds a Whisper-based alternative
that:
  - works in any browser (audio is recorded client-side via MediaRecorder /
    WebRTC getUserMedia — already present in the frontend — and POSTed here),
  - is far more accurate for accented/noisy speech, which matters a lot for
    a fair mock-interview grade,
  - can run against Groq's fast Whisper-large-v3 endpoint (OpenAI-compatible
    API) or a fully local faster-whisper model for offline/zero-cost demos.
"""
import io

from app.config import get_settings

settings = get_settings()

_local_model = None


async def _transcribe_openai_compatible(base_url: str, api_key: str, model: str, filename: str, content: bytes) -> str:
    import httpx
    files = {"file": (filename, io.BytesIO(content), "application/octet-stream")}
    data = {"model": model}
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{base_url}/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            data=data,
            files=files,
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json().get("text", "")


def _transcribe_local(filename: str, content: bytes) -> str:
    global _local_model
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "Local Whisper requested (WHISPER_PROVIDER=local) but 'faster-whisper' isn't "
            "installed. Run `pip install faster-whisper` or switch WHISPER_PROVIDER to "
            "'groq' in .env."
        ) from exc
    if _local_model is None:
        _local_model = WhisperModel(settings.LOCAL_WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")
    import tempfile, os as _os
    suffix = "." + filename.split(".")[-1] if "." in filename else ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name
    try:
        segments, _info = _local_model.transcribe(tmp_path)
        return " ".join(seg.text.strip() for seg in segments)
    finally:
        _os.unlink(tmp_path)


async def transcribe_audio(filename: str, content: bytes) -> dict:
    provider = settings.WHISPER_PROVIDER
    if provider == "local":
        text = _transcribe_local(filename, content)
        return {"text": text.strip(), "provider": "local-faster-whisper"}
    # default: groq (only remaining hosted option besides local)
    if not settings.GROQ_API_KEY:
        raise RuntimeError("WHISPER_PROVIDER=groq but GROQ_API_KEY is not set.")
    text = await _transcribe_openai_compatible(
        "https://api.groq.com/openai/v1", settings.GROQ_API_KEY, "whisper-large-v3", filename, content)
    return {"text": text.strip(), "provider": "groq-whisper-large-v3"}
