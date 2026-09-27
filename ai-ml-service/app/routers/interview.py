from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.config import get_settings
from app.services import transcribe as transcribe_service
from app.services import interview_nlp

router = APIRouter(prefix="/interview", tags=["mock-interview"])
settings = get_settings()


@router.post("/transcribe")
async def transcribe_endpoint(file: UploadFile = File(...)):
    content = await file.read()
    size_mb = len(content) / (1024 * 1024)
    if size_mb > settings.MAX_UPLOAD_MB:
        raise HTTPException(413, f"Audio exceeds {settings.MAX_UPLOAD_MB}MB limit")
    try:
        return await transcribe_service.transcribe_audio(file.filename or "answer.webm", content)
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))


# ===== NLP / Speech Analysis — real-time transcript evaluation =====

class AnalyzeRequest(BaseModel):
    question: str
    answer: str
    role: Optional[str] = Field(None, description="Target role/domain, e.g. 'Software Engineer'")
    duration_seconds: Optional[float] = Field(None, description="Spoken duration, if known — enables WPM/pace")


@router.post("/analyze")
async def analyze_endpoint(req: AnalyzeRequest):
    """Single-shot evaluation: linguistic analysis (filler/hedge/pace/sentiment/confidence) +
    LLM-backed domain-specific feedback (STAR structure, technical depth, follow-up question)."""
    return await interview_nlp.evaluate_answer(req.question, req.answer, req.role, req.duration_seconds)


@router.post("/analyze/rubric")
async def analyze_rubric_endpoint(req: AnalyzeRequest):
    """NEW: deepens /analyze into a 4-competency rubric (Communication, Technical Depth,
    Problem Solving, Confidence) \u2014 what the summary screen's competency chart actually
    wants, built from the same evaluate_answer() call at no extra LLM cost."""
    evaluation = await interview_nlp.evaluate_answer(req.question, req.answer, req.role, req.duration_seconds)
    return {**evaluation, "rubric": interview_nlp.rubric_breakdown(evaluation)}


class QuickAnalyzeRequest(BaseModel):
    text: str
    duration_seconds: Optional[float] = None


@router.post("/analyze/linguistic")
async def analyze_linguistic_endpoint(req: QuickAnalyzeRequest):
    """Cheap, deterministic, no-LLM-call variant for live/real-time-as-you-speak scoring
    (e.g. called every few seconds against the growing transcript during recording)."""
    return interview_nlp.analyze_transcript(req.text, req.duration_seconds)


# ===== Multi-turn adaptive mock interview session =====

class StartInterviewRequest(BaseModel):
    role: str = Field(..., examples=["Software Engineer"])
    domain_focus: Optional[str] = None


@router.post("/session/start")
async def start_interview_session_endpoint(req: StartInterviewRequest):
    return interview_nlp.start_interview_session(req.role, req.domain_focus)


class RespondRequest(BaseModel):
    session_id: str
    answer: str
    duration_seconds: Optional[float] = None


@router.post("/session/respond")
async def respond_endpoint(req: RespondRequest):
    try:
        return await interview_nlp.respond_in_session(req.session_id, req.answer, req.duration_seconds)
    except KeyError as exc:
        raise HTTPException(404, str(exc))


# ===== Multimodal Interview Intelligence (spec §10): TEXT + AUDIO + VIDEO =====

@router.post("/session/respond/multimodal")
async def respond_multimodal_endpoint(
    session_id: str = Form(...),
    answer: str = Form(...),
    duration_seconds: Optional[float] = Form(None),
    audio: Optional[UploadFile] = File(None),
    video: Optional[UploadFile] = File(None),
):
    """Same adaptive session flow as /session/respond, plus optional speech-prosody
    (pauses/pitch) and visual-behavior (face presence/posture/gaze) analysis when an audio
    and/or video clip of the answer is attached. `answer` is still required as text (the
    frontend's existing browser SpeechRecognition or a separate call to /interview/transcribe
    already produces it) — this endpoint does not re-transcribe audio itself, so a session
    stays fully usable text-only by simply omitting audio/video."""
    audio_bytes = await audio.read() if audio else None
    video_bytes = await video.read() if video else None
    for content, label, limit_mb in ((audio_bytes, "Audio", settings.MAX_UPLOAD_MB),
                                      (video_bytes, "Video", settings.MAX_UPLOAD_MB * 5)):
        if content and len(content) / (1024 * 1024) > limit_mb:
            raise HTTPException(413, f"{label} exceeds {limit_mb}MB limit")
    try:
        return await interview_nlp.respond_in_session_multimodal(
            session_id, answer, duration_seconds,
            audio_bytes=audio_bytes, audio_filename=audio.filename if audio else None,
            video_bytes=video_bytes, video_filename=video.filename if video else None,
        )
    except KeyError as exc:
        raise HTTPException(404, str(exc))
