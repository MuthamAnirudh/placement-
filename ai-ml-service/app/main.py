"""
Campus Placement Portal — Advanced AI/ML Intelligence Service (FastAPI)

This is a SEPARATE, ADDITIVE microservice that sits alongside the existing
Express `backend/` (which still powers Ask AI / Resume-JD chat-style calls
unchanged). This service adds the heavier ML/NLP capabilities that don't fit
a simple LLM-proxy pattern:

  /parse/*      resume + JD parsing (PyPDF2/docx + spaCy/NLP + LLM enrichment)
  /roadmap/*    week-by-week actionable "build this next" career roadmaps
  /match/*      semantic (vector) skill/resume matching — FAISS/Qdrant/Pinecone
  /interview/*  Whisper speech-to-text + NLP/sentiment analysis + multi-turn AI mock interviewer
  /adaptive/*   Adaptive Skill Diagnostic Engine (IRT-based quiz + coding assessment)
  /market/*     Skill Gap & Market Intelligence Radar (live + cached job-market data)

Nothing in the existing frontend or Express backend is modified in a
breaking way — the frontend calls this service ONLY when a URL is configured
in Settings → AI/ML Intelligence Service, and every feature that uses it has
a working fallback when it isn't configured, so no previously-built feature
is ever removed or made worse.
"""
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.routers import adaptive, benchmark, career_path, interview, market, match, parse, roadmap

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("ai_ml_service")

settings = get_settings()

USAGE = {"total_requests": 0, "errors": 0, "by_route": {}}

# Very light prompt-injection tripwire (mirrors backend/server.js) — logs, never blocks,
# since false positives on legitimate resume content (e.g. "ignore" appearing in a cover
# letter) would be worse than the risk here.
_INJECTION_PATTERNS = re.compile(r"ignore (all|previous) instructions|reveal (your|the) system prompt", re.I)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # BUGFIX: this used to be named `missing` while actually holding the list of
    # *configured* keys, which inverted the reading of the check below (it happened to
    # still evaluate correctly only because both branches were negated). Renamed for
    # correctness, and now reports partial configuration too instead of staying silent
    # whenever at least one key is present.
    provider_keys = {"GROQ_API_KEY": settings.GROQ_API_KEY, "GEMINI_API_KEY": settings.GEMINI_API_KEY}
    configured = [name for name, val in provider_keys.items() if val]
    missing = [name for name, val in provider_keys.items() if not val]
    if not configured:
        logger.warning(
            "No LLM provider key is configured — /roadmap and LLM-enriched /parse will use "
            "offline fallbacks only. Set at least one of GROQ_API_KEY / GEMINI_API_KEY "
            "in ai-ml-service/.env for full functionality."
        )
    elif missing:
        logger.info(
            "LLM provider(s) configured: %s. %s not set — requests will fall back to the "
            "configured provider(s) if one fails.",
            ", ".join(configured), ", ".join(missing),
        )
    if not settings.DOTENV_LOADED and not any(os.getenv(k) for k in provider_keys):
        logger.warning(
            "python-dotenv is not installed, so ai-ml-service/.env was NOT loaded — only real "
            "OS environment variables are visible. If you have keys in .env but nothing is "
            "configured above, run `pip install python-dotenv` (already in requirements.txt) "
            "and restart."
        )
    if settings.CORS_ORIGINS == ["*"] and settings.ENV == "production":
        logger.warning("CORS_ORIGINS is '*' in production — restrict this to your frontend's real origin.")
    logger.info("AI/ML Intelligence Service starting on %s:%s (env=%s)", settings.HOST, settings.PORT, settings.ENV)
    yield
    logger.info("AI/ML Intelligence Service shutting down")


app = FastAPI(
    title="Campus Placement Portal — AI/ML Intelligence Service",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o for o in settings.CORS_ORIGINS if o != "*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Service-Token", "X-Request-ID"],
)


@app.middleware("http")
async def trusted_backend_only(request: Request, call_next):
    # Health is intentionally public liveness information. All functional AI/ML routes
    # require the secret shared only by Express and this service in production.
    # The AI/ML service is intended to be reached through the Express gateway.
    # Keep health public for orchestration, but protect functional endpoints and usage
    # diagnostics with the shared service token.
    public_paths = {"/health", "/docs", "/openapi.json", "/redoc"}
    if request.url.path not in public_paths and request.method != "OPTIONS":
        configured = settings.AI_SERVICE_TOKEN
        if settings.ENV == "production" and not configured:
            return JSONResponse(status_code=503, content={"error":"AI/ML service authentication is not configured."})
        if configured:
            presented = request.headers.get("x-service-token", "")
            import secrets
            if not presented or not secrets.compare_digest(presented, configured):
                return JSONResponse(status_code=401, content={"error":"Unauthorized."})
    return await call_next(request)


@app.middleware("http")
async def request_logging_and_usage(request: Request, call_next):
    req_id = request.headers.get("x-request-id") or str(uuid.uuid4())[:8]
    start = time.time()
    USAGE["total_requests"] += 1
    route = request.url.path
    USAGE["by_route"][route] = USAGE["by_route"].get(route, 0) + 1
    try:
        response = await call_next(request)
        elapsed_ms = round((time.time() - start) * 1000)
        logger.info("[%s] %s %s -> %s (%sms)", req_id, request.method, route, response.status_code, elapsed_ms)
        response.headers["X-Request-ID"] = req_id
        return response
    except Exception:
        USAGE["errors"] += 1
        logger.exception("[%s] %s %s failed", req_id, request.method, route)
        raise


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    USAGE["errors"] += 1
    logger.exception("Unhandled error on %s", request.url.path)
    return JSONResponse(status_code=500, content={"error": "Internal server error", "requestId": request.headers.get("x-request-id")})


app.include_router(parse.router)
app.include_router(roadmap.router)
app.include_router(match.router)
app.include_router(interview.router)
app.include_router(adaptive.router)
app.include_router(market.router)
app.include_router(career_path.router)
app.include_router(benchmark.router)


@app.get("/health")
async def health():
    # Public liveness only; operational details stay behind the Express gateway.
    return {"status": "ok", "service": settings.SERVICE_NAME}


@app.get("/usage")
async def usage():
    return USAGE


@app.get("/")
async def root():
    return {
        "service": "Campus Placement Portal — AI/ML Intelligence Service",
        "docs": "/docs",
        "health": "/health",
        "endpoints": [
            "POST /parse/resume", "POST /parse/jd",
            "POST /roadmap/generate",
            "POST /match/resume-jd", "POST /match/index", "POST /match/search",
            "POST /interview/transcribe", "POST /interview/analyze", "POST /interview/analyze/linguistic",
            "POST /interview/session/start", "POST /interview/session/respond",
            "GET /adaptive/topics", "POST /adaptive/session/start", "POST /adaptive/session/answer",
            "POST /adaptive/session/coding-submit", "GET /adaptive/session/{id}/report",
            "POST /adaptive/mastery/freshness",
            "GET /market/roles", "POST /market/radar", "GET /market/trending", "GET /market/heat-index",
            "GET /career-path/archetypes", "POST /career-path/predict",
            "POST /benchmark/percentile",
            "POST /interview/analyze/rubric",
        ],
    }
