from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services import career_path

router = APIRouter(prefix="/career-path", tags=["career-path-predictor"])


@router.get("/archetypes")
async def list_archetypes_endpoint():
    return {"archetypes": career_path.list_archetypes()}


class PredictRequest(BaseModel):
    current_skills: list[str] = Field(default_factory=list)
    topic_mastery: Optional[dict[str, float]] = Field(
        None, description="Optional {topic: 0-1 mastery} \u2014 pass per-topic theta/100 from an adaptive report to weight the match"
    )
    target_interest: Optional[str] = Field(None, description="Free-text nudge, e.g. 'data science'")
    top_n: int = Field(3, ge=1, le=6)


@router.post("/predict")
async def predict_endpoint(req: PredictRequest):
    """Ranked career-path matches against a curated archetype set, each with its own
    week-by-week milestone plan. Always works offline (pure skill-overlap scoring); adds a
    short LLM rationale on top of the #1 match when a provider key is configured."""
    return await career_path.predict(req.current_skills, req.topic_mastery, req.target_interest, req.top_n)
