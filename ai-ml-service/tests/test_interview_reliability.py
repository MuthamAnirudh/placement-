"""
Unit tests for the AI Reliability layer (spec §16) wired into interview_nlp.evaluate_answer.

Verifies:
  1. When the LLM path succeeds, feedback["reliability"] is attached and correctly flags a
     coaching response that invents specifics never in the candidate's actual answer.
  2. A feedback response that stays grounded in what the candidate said scores as grounded.
  3. The offline-template path (no LLM key / LLM error) never gets a reliability block —
     checking deterministic template text against itself would be circular (matches the
     existing career_path.py/roadmap.py convention documented in ai_reliability.py).

No network calls: call_llm is monkeypatched directly.

Run from ai-ml-service/:
    pytest tests/test_interview_reliability.py -v
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import asyncio
import json

from app.services import interview_nlp  # noqa: E402

QUESTION = "Tell me about a time you optimized a slow database query."
ANSWER = (
    "At my last internship I noticed a dashboard query was taking 4 seconds. I added an "
    "index on the customer_id column and rewrote a subquery as a join, which brought it "
    "down to under 200 milliseconds. I used PostgreSQL's EXPLAIN ANALYZE to find the "
    "bottleneck before making any changes."
)

GROUNDED_LLM_JSON = json.dumps({
    "star_structure_present": True,
    "star_notes": "Clear situation and action: you identified the slow dashboard query and "
                   "used EXPLAIN ANALYZE before changing anything.",
    "technical_depth_0_10": 8,
    "communication_clarity_0_10": 8,
    "strengths": ["You quantified the improvement from 4 seconds to under 200 milliseconds."],
    "improvements": ["Mention who else was affected by the slow dashboard query."],
    "ideal_answer_outline": ["State the situation", "Describe the index and join change",
                              "Quantify the result", "Reflect on what you'd check first next time"],
    "follow_up_question": "How did you decide an index was the right fix instead of caching?",
})

HALLUCINATED_LLM_JSON = json.dumps({
    "star_structure_present": True,
    "star_notes": "Good use of Redis caching and a Kafka pipeline to fix the MongoDB "
                   "replica lag you described.",
    "technical_depth_0_10": 7,
    "communication_clarity_0_10": 7,
    "strengths": ["Your Kubernetes horizontal pod autoscaler tuning was impressive."],
    "improvements": ["Discuss the GraphQL schema migration in more depth."],
    "ideal_answer_outline": ["Explain the Kafka setup", "Discuss sharding strategy"],
    "follow_up_question": "What was your Elasticsearch cluster's shard count?",
})


class _FakeResult(dict):
    pass


def _mock_call_llm(response_text):
    async def _inner(system, user, opts):
        return {"text": response_text, "provider": "fake"}
    return _inner


def test_grounded_feedback_scores_high(monkeypatch):
    monkeypatch.setattr(interview_nlp, "call_llm", _mock_call_llm(GROUNDED_LLM_JSON))
    result = asyncio.run(interview_nlp.evaluate_answer(QUESTION, ANSWER))
    feedback = result["feedback"]
    assert feedback["generated_by"] == "llm:fake"
    assert "reliability" in feedback
    assert feedback["reliability"]["confidence_label"] in ("high", "medium")


def test_hallucinated_feedback_flagged_low(monkeypatch):
    monkeypatch.setattr(interview_nlp, "call_llm", _mock_call_llm(HALLUCINATED_LLM_JSON))
    result = asyncio.run(interview_nlp.evaluate_answer(QUESTION, ANSWER))
    feedback = result["feedback"]
    reliability = feedback["reliability"]
    assert reliability["confidence_label"] == "low"
    assert reliability["unsupported_claims"], "invented Kafka/Redis/Kubernetes claims should be flagged"


def test_offline_path_has_no_reliability_block(monkeypatch):
    async def _broken_call_llm(system, user, opts):
        raise interview_nlp.LLMError("no provider key configured")

    monkeypatch.setattr(interview_nlp, "call_llm", _broken_call_llm)
    result = asyncio.run(interview_nlp.evaluate_answer(QUESTION, ANSWER))
    feedback = result["feedback"]
    assert feedback["generated_by"] == "offline-template (no LLM key configured)"
    assert "reliability" not in feedback
