from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import adaptive_engine

router = APIRouter(prefix="/adaptive", tags=["adaptive-diagnostic"])


@router.get("/topics")
async def list_topics_endpoint():
    return {"topics": adaptive_engine.list_topics()}


class StartSessionRequest(BaseModel):
    topics: list[str] = Field(default_factory=list, description="Subset of /adaptive/topics; empty = first 3 topics")
    include_coding: bool = True
    max_questions: Optional[int] = Field(None, ge=3, le=30)


@router.post("/session/start")
async def start_session_endpoint(req: StartSessionRequest):
    return adaptive_engine.start_session(req.topics, req.include_coding, req.max_questions)


class AnswerRequest(BaseModel):
    session_id: str
    item_id: str
    selected_index: int = Field(..., ge=0, le=3)


@router.post("/session/answer")
async def submit_answer_endpoint(req: AnswerRequest):
    try:
        return adaptive_engine.submit_answer(req.session_id, req.item_id, req.selected_index)
    except KeyError as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(422, str(exc))


class CodingAnswerRequest(BaseModel):
    session_id: str
    topic: str
    prompt: str
    code: str


@router.post("/session/coding-submit")
async def submit_coding_endpoint(req: CodingAnswerRequest):
    try:
        return await adaptive_engine.submit_coding_answer(req.session_id, req.topic, req.prompt, req.code)
    except KeyError as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@router.get("/session/{session_id}/report")
async def get_report_endpoint(session_id: str):
    try:
        return adaptive_engine.get_report(session_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc))


class MasteryEntry(BaseModel):
    topic: str
    theta: float
    last_practiced_at: str = Field(..., description="ISO-8601 timestamp of when this theta was measured")


class MasteryFreshnessRequest(BaseModel):
    entries: list[MasteryEntry]


@router.post("/mastery/freshness")
async def mastery_freshness_endpoint(req: MasteryFreshnessRequest):
    """NEW: 'Skill Freshness' \u2014 applies a spaced-repetition-style decay curve to a batch of
    saved per-topic theta values so the dashboard can flag which skill levels are stale and
    worth re-testing, instead of trusting an old diagnostic snapshot indefinitely."""
    return {"mastery": adaptive_engine.mastery_report_with_decay([e.model_dump() for e in req.entries])}
