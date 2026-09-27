"""
Unit tests for ai_reliability.py (spec §16).

Includes the exact grounded-vs-hallucinated scenario that caught a real bug during
development: an initial version scored a genuinely grounded rationale *lower* than a
hallucinated one, because the project's embedding fallback (no sentence-transformers
installed) is a bag-of-words hash that only catches literal shared tokens, not paraphrase.
The notable-term check (proper nouns/figures) was added specifically to fix this — these
tests exist to make sure it stays fixed.

Pure-function tests, no network, no LLM calls. Run from ai-ml-service/:

    pytest tests/test_ai_reliability.py -v
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.ai_reliability import check_reliability, extract_claims, verify_claim  # noqa: E402

KNOWN_FACTS = [
    "Backend Engineer matched skills: Python, SQL, Docker.",
    "Backend Engineer missing skills: Kubernetes, System Design.",
    "Skill coverage confidence for Backend Engineer is 72%.",
    "Python is a matched skill for Backend Engineer.",
    "SQL is a matched skill for Backend Engineer.",
    "Docker is a matched skill for Backend Engineer.",
    "Kubernetes is a missing skill for Backend Engineer, recommended to learn next.",
    "System Design is a missing skill for Backend Engineer, recommended to learn next.",
]

GROUNDED_TEXT = (
    "Backend Engineer is your closest match because you already have strong Python, "
    "SQL, and Docker experience. Learning Kubernetes next would round out your "
    "container orchestration skills for this role."
)
HALLUCINATED_TEXT = (
    "Backend Engineer is your closest match. You should focus on learning Rust "
    "and blockchain development, and note that this role typically pays over "
    "$300,000 per year at most companies."
)


def test_grounded_text_scores_higher_than_hallucinated_text():
    grounded = check_reliability(GROUNDED_TEXT, KNOWN_FACTS)
    hallucinated = check_reliability(HALLUCINATED_TEXT, KNOWN_FACTS)
    assert grounded["groundedness_score"] > hallucinated["groundedness_score"]


def test_fully_grounded_text_gets_high_confidence_label():
    result = check_reliability(GROUNDED_TEXT, KNOWN_FACTS)
    assert result["confidence_label"] == "high"
    assert result["groundedness_score"] == 1.0


def test_invented_dollar_figure_is_flagged_unsupported():
    result = check_reliability(HALLUCINATED_TEXT, KNOWN_FACTS)
    assert any("$300,000" in c for c in result["unsupported_claims"])


def test_claim_naming_an_unrelated_specific_skill_is_ungrounded():
    verified = verify_claim("You should really learn Rust for this role.", KNOWN_FACTS)
    assert verified["grounded"] is False
    assert verified["notable_terms_grounded_ratio"] == 0.0


def test_claim_naming_a_known_skill_is_grounded_via_notable_terms():
    verified = verify_claim("Docker experience is a strong point here.", KNOWN_FACTS)
    assert verified["grounded"] is True


def test_empty_text_returns_not_applicable_not_a_fabricated_score():
    result = check_reliability("", KNOWN_FACTS)
    assert result["groundedness_score"] is None
    assert result["confidence_label"] == "not_applicable"


def test_short_fragments_are_not_treated_as_claims():
    assert extract_claims("Yes. Sure. OK then.") == []


def test_no_known_facts_means_nothing_can_be_grounded():
    result = check_reliability(GROUNDED_TEXT, [])
    assert result["groundedness_score"] == 0.0
    assert result["confidence_label"] == "low"


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-v"]))
