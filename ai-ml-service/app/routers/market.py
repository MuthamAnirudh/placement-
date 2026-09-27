from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services import market_intel

router = APIRouter(prefix="/market", tags=["market-intelligence"])


@router.get("/roles")
async def list_roles_endpoint():
    return {"roles": market_intel.list_roles()}


class RadarRequest(BaseModel):
    target_role: str = Field(..., examples=["Data Scientist"])
    current_skills: list[str] = Field(default_factory=list)


@router.post("/radar")
async def radar_endpoint(req: RadarRequest):
    return await market_intel.compute_radar(req.target_role, req.current_skills)


@router.get("/trending")
async def trending_endpoint(role: Optional[str] = None):
    return await market_intel.trending_skills(role)


@router.get("/heat-index")
async def heat_index_endpoint(role: str):
    """NEW: deepens the radar with a single 'how hot is this role right now' score, ranked
    against every other role in the dataset (e.g. '#3 of 12 roles')."""
    return await market_intel.market_heat_index(role)
