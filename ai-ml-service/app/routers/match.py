from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services import matcher, parser
from app.services.explainability import resume_match_evidence

router = APIRouter(prefix="/match", tags=["semantic-match"])


class ResumeJdRequest(BaseModel):
    resume_text: str
    jd_text: str


@router.post("/resume-jd")
async def match_resume_jd_endpoint(req: ResumeJdRequest):
    """Kept for backward compatibility: whole-document semantic_similarity only.
    Prefer POST /match/resume-jd/explain for the skill-level breakdown."""
    return matcher.match_resume_to_jd(req.resume_text, req.jd_text)


class ExplainableMatchRequest(BaseModel):
    resume_text: str = ""
    jd_text: str = ""
    # Optional pre-extracted skill lists (e.g. already returned by an earlier call to
    # POST /parse/resume or POST /parse/jd) so this endpoint doesn't re-run extraction.
    # If omitted, skills are extracted here from resume_text/jd_text.
    resume_skills: Optional[list[str]] = None
    jd_skills: Optional[list[str]] = None


@router.post("/resume-jd/explain")
async def explain_resume_jd_endpoint(req: ExplainableMatchRequest):
    """Explainable Competency Matching (spec §9): per-skill matched / partially-matched /
    missing breakdown with evidence, instead of a single opaque cosine score. Feed the
    `matched_skills` from this response into POST /api/twin/sync-resume-match (Node backend)
    to record them on the Student Digital Twin."""
    resume_skills = req.resume_skills
    if resume_skills is None:
        resume_skills = parser.extract_skills(req.resume_text) if req.resume_text else []
    jd_skills = req.jd_skills
    if jd_skills is None:
        jd_skills = parser.extract_skills(req.jd_text) if req.jd_text else []

    result = matcher.explain_resume_jd_match(resume_skills, jd_skills, req.resume_text, req.jd_text)
    result["evidence"] = resume_match_evidence(result)
    return result


class IndexRequest(BaseModel):
    profile_id: str
    text: str
    metadata: dict = Field(default_factory=dict)


@router.post("/index")
async def index_profile_endpoint(req: IndexRequest):
    matcher.index_profile(req.profile_id, req.text, req.metadata)
    return {"status": "indexed", "profile_id": req.profile_id, "backend": matcher.settings.VECTOR_BACKEND}


class SemanticSearchRequest(BaseModel):
    query: str
    top_k: int = Field(5, ge=1, le=50)


@router.post("/search")
async def semantic_search_endpoint(req: SemanticSearchRequest):
    results = matcher.semantic_search(req.query, req.top_k)
    return {"results": results, "backend": matcher.settings.VECTOR_BACKEND}
