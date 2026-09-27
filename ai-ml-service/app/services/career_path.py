"""
AI Career Path Predictor.

New AI/ML capability (not just a deepening of the existing 3). Given a student's current
skills and/or per-topic mastery from the Adaptive Diagnostic Engine, scores them against a
curated set of career archetypes (data/career_paths.json) by skill overlap, and returns a
ranked list of "you're closest to X" tracks with the concrete milestone roadmap for each.

Follows the same offline-first pattern as market_intel.py and roadmap.py: the ranking and
milestones always work with zero external calls (pure set-overlap scoring against the
curated dataset), and — only if an LLM provider key is configured — an optional short
natural-language rationale is layered on top of the #1 match. A failed/unconfigured LLM
call degrades to the deterministic rationale, never an error.
"""
import json
from pathlib import Path
from typing import Optional

from app.services.llm_providers import call_llm, LLMError
from app.services.explainability import career_match_evidence
from app.services.ai_reliability import check_reliability

_DATA_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "career_paths.json"
with open(_DATA_PATH, "r") as _f:
    _DATASET = json.load(_f)

_ARCHETYPES: list[dict] = _DATASET["archetypes"]


def list_archetypes() -> list[dict]:
    return [{"id": a["id"], "title": a["title"], "core_skills": a["core_skills"]} for a in _ARCHETYPES]


def _normalize(skill: str) -> str:
    return skill.strip().lower()


def _score_archetype(archetype: dict, skill_set: set[str], mastery: dict[str, float]) -> dict:
    core = [_normalize(s) for s in archetype["core_skills"]]
    matched = [s for s in core if s in skill_set]
    missing = [archetype["core_skills"][i] for i, s in enumerate(core) if s not in skill_set]

    coverage = len(matched) / len(core) if core else 0.0
    # Weight matched skills by mastery level if we have adaptive-engine theta/level data for
    # them (0-1 scale expected; unknown skills default to 0.6 — "some exposure, unverified").
    mastery_bonus = sum(mastery.get(s, 0.6) for s in matched) / len(core) if core else 0.0
    confidence = round(100 * (0.6 * coverage + 0.4 * mastery_bonus), 1)

    result = {
        "id": archetype["id"],
        "title": archetype["title"],
        "confidence": confidence,
        "matched_skills": [archetype["core_skills"][i] for i, s in enumerate(core) if s in skill_set],
        "missing_skills": missing,
        "milestones": archetype["milestones"],
    }
    # Exact decomposition stashed for the caller (predict()) to finalize once it knows whether
    # the target-interest boost applied — kept off the public dict shape until then.
    result["_coverage"] = coverage
    result["_mastery_bonus"] = mastery_bonus
    return result


async def predict(
    current_skills: list[str],
    topic_mastery: Optional[dict[str, float]] = None,
    target_interest: Optional[str] = None,
    top_n: int = 3,
) -> dict:
    skill_set = {_normalize(s) for s in current_skills}
    mastery = {_normalize(k): v for k, v in (topic_mastery or {}).items()}

    scored = [_score_archetype(a, skill_set, mastery) for a in _ARCHETYPES]

    interest_matched_ids: set[str] = set()
    if target_interest:
        interest = target_interest.strip().lower()
        for s in scored:
            if interest in s["title"].lower() or interest in s["id"]:
                s["confidence"] = min(100.0, s["confidence"] + 15)
                interest_matched_ids.add(s["id"])

    scored.sort(key=lambda s: s["confidence"], reverse=True)
    top = scored[:top_n]

    # Build exact, non-fabricated "why this recommendation" evidence for each returned match,
    # then drop the internal-only decomposition fields from the public response shape.
    for s in top:
        s["evidence"] = career_match_evidence(
            s, s["_coverage"], s["_mastery_bonus"], s["id"] in interest_matched_ids
        )
        del s["_coverage"]
        del s["_mastery_bonus"]

    rationale = (
        f"Based on overlap with your current skills, {top[0]['title']} is your closest match "
        f"({top[0]['confidence']}% skill coverage)."
        if top else "Add a few skills to get a career-path match."
    )
    llm_used = False
    if top:
        try:
            system = (
                "You are a concise, encouraging career coach for campus placement students in India. "
                "In 2-3 sentences, explain why the given top career-path match fits the student's current "
                "skills, and name the single most valuable skill to learn next from the missing list. "
                "No markdown, no preamble, plain text only."
            )
            user = json.dumps({
                "top_match": top[0]["title"],
                "matched_skills": top[0]["matched_skills"],
                "missing_skills": top[0]["missing_skills"],
                "confidence": top[0]["confidence"],
            })
            result = await call_llm(system, user, opts={"maxTokens": 220, "temperature": 0.5})
            text = (result or {}).get("text", "")
            if text and text.strip():
                rationale = text.strip()
                llm_used = True
        except LLMError:
            pass  # deterministic rationale above already covers this

    response = {"matches": top, "rationale": rationale, "llm_enriched": llm_used}

    # AI Reliability layer (spec §16): only meaningful for LLM-generated text — the
    # deterministic rationale above is built directly from these same facts, so checking it
    # against itself would be circular and add nothing.
    if llm_used:
        known_facts = [
            f"{top[0]['title']} matched skills: {', '.join(top[0]['matched_skills']) or 'none'}.",
            f"{top[0]['title']} missing skills: {', '.join(top[0]['missing_skills']) or 'none'}.",
            f"Skill coverage confidence for {top[0]['title']} is {top[0]['confidence']}%.",
        ]
        known_facts += [f"{s} is a matched skill for {top[0]['title']}." for s in top[0]["matched_skills"]]
        known_facts += [f"{s} is a missing skill for {top[0]['title']}, recommended to learn next."
                         for s in top[0]["missing_skills"]]
        reliability = check_reliability(rationale, known_facts)
        response["rationale_reliability"] = reliability
        if reliability.get("confidence_label") == "low":
            response["rationale"] = (
                f"Based on overlap with your current skills, {top[0]['title']} is your closest match "
                f"({top[0]['confidence']}% skill coverage)."
            )
            response["rationale_replaced"] = True

    return response
