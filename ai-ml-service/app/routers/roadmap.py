from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services import roadmap as roadmap_service

router = APIRouter(prefix="/roadmap", tags=["roadmap"])


class RoadmapRequest(BaseModel):
    target_role: str = Field(..., examples=["Full Stack Developer"])
    current_skills: list[str] = Field(default_factory=list)
    missing_skills: list[str] = Field(default_factory=list)
    resume_summary: Optional[str] = None
    duration_weeks: int = Field(6, ge=1, le=16)
    provider: Optional[str] = Field(None, description="Force one of: groq, gemini")


@router.post("/generate")
async def generate_roadmap_endpoint(req: RoadmapRequest):
    return await roadmap_service.generate_roadmap(
        target_role=req.target_role,
        current_skills=req.current_skills,
        missing_skills=req.missing_skills,
        resume_summary=req.resume_summary,
        duration_weeks=req.duration_weeks,
        provider=req.provider,
    )
