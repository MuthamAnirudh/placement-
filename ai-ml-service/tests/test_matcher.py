"""
Unit tests for the Explainable Competency Matching layer added to matcher.py (spec §9).

Pure-function tests only (no FastAPI/httpx dependency, no network — the hashed fallback
embedding in matcher.embed() is deterministic and offline), so these run with plain pytest
and no service needs to be booted. Run from ai-ml-service/:

    pytest tests/test_matcher.py -v
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.matcher import explain_resume_jd_match  # noqa: E402
from app.services.explainability import resume_match_evidence  # noqa: E402


def test_exact_skill_match_is_classified_as_matched():
    result = explain_resume_jd_match(resume_skills=["python", "sql"], jd_skills=["python"])
    assert len(result["matched_skills"]) == 1
    assert result["matched_skills"][0]["skill"] == "python"
    assert result["matched_skills"][0]["confidence"] == 1.0
    assert result["matched_skills"][0]["match_type"] == "exact"


def test_completely_unrelated_skill_is_missing():
    result = explain_resume_jd_match(resume_skills=["python"], jd_skills=["kubernetes"])
    assert len(result["missing_skills"]) == 1
    assert result["missing_skills"][0]["skill"] == "kubernetes"
    assert len(result["matched_skills"]) == 0
    assert len(result["partially_matched_skills"]) == 0


def test_empty_resume_means_every_jd_skill_is_missing():
    result = explain_resume_jd_match(resume_skills=[], jd_skills=["docker", "kubernetes"])
    assert len(result["missing_skills"]) == 2
    assert result["skill_coverage_score"] == 0.0


def test_coverage_score_counts_exact_matches_as_a_full_point():
    result = explain_resume_jd_match(resume_skills=["python", "sql"], jd_skills=["python", "sql"])
    assert result["skill_coverage_score"] == 100.0


def test_case_insensitive_exact_match():
    result = explain_resume_jd_match(resume_skills=["Python"], jd_skills=["PYTHON"])
    assert len(result["matched_skills"]) == 1


def test_evidence_factors_sum_back_to_the_displayed_score():
    result = explain_resume_jd_match(resume_skills=["python"], jd_skills=["python", "kubernetes"])
    evidence = resume_match_evidence(result)
    total_contribution = round(sum(f["contribution_pct"] for f in evidence["factors"]), 1)
    assert total_contribution == round(result["skill_coverage_score"], 1)


def test_missing_skills_never_appear_in_matched_or_partial():
    result = explain_resume_jd_match(resume_skills=["python", "sql"], jd_skills=["python", "rust", "sql"])
    matched_names = {m["skill"] for m in result["matched_skills"]}
    partial_names = {p["skill"] for p in result["partially_matched_skills"]}
    missing_names = {m["skill"] for m in result["missing_skills"]}
    assert matched_names.isdisjoint(missing_names)
    assert partial_names.isdisjoint(missing_names)


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-v"]))
