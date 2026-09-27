from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.config import get_settings
from app.services import parser

router = APIRouter(prefix="/parse", tags=["parsing"])
settings = get_settings()


@router.post("/resume")
async def parse_resume_endpoint(
    file: UploadFile = File(...),
    use_llm_enrichment: bool = Form(True),
):
    content = await file.read()
    size_mb = len(content) / (1024 * 1024)
    if size_mb > settings.MAX_UPLOAD_MB:
        raise HTTPException(413, f"File exceeds {settings.MAX_UPLOAD_MB}MB limit")
    try:
        result = await parser.parse_resume(file.filename, content, use_llm_enrichment=use_llm_enrichment)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))
    return result


@router.post("/jd")
async def parse_jd_endpoint(text: str = Form(...)):
    if not text.strip():
        raise HTTPException(422, "Job description text is empty")
    return parser.parse_job_description(text)
