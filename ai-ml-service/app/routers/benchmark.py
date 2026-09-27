from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services import benchmark

router = APIRouter(prefix="/benchmark", tags=["peer-benchmarking"])


class PercentileRequest(BaseModel):
    user_score: float = Field(..., description="The current user's score/theta/match-% for this result type")
    peer_scores: list[float] = Field(
        default_factory=list,
        description="Anonymized peer scores, e.g. from GET /api/results/peer-stats on the backend",
    )


@router.post("/percentile")
async def percentile_endpoint(req: PercentileRequest):
    """Where does this score rank against everyone else's? Pure stats, no LLM call \u2014
    always fast and always available, even with zero AI provider keys configured."""
    return benchmark.compute_percentile(req.user_score, req.peer_scores)
