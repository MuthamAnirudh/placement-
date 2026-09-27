"""
Adaptive Skill Diagnostic Engine.

Real-time difficulty adaptation using a 1-parameter logistic (Rasch/IRT) model:

    P(correct | theta, b) = 1 / (1 + exp(-(theta - b)))

where `theta` is the candidate's estimated ability and `b` is the item's difficulty.
After each response we take a bounded Newton/gradient step on theta (a lightweight,
dependency-free approximation of MLE ability estimation — no numpy/scipy required so
this always runs, even with zero ML packages installed), then serve the next item
whose difficulty `b` is closest to the *current* theta estimate (maximum-information
item selection under the Rasch model is exactly the item where b ≈ theta).

The session ends once either:
  - ADAPTIVE_MAX_QUESTIONS is reached, or
  - the standard error of theta drops below ADAPTIVE_SE_THRESHOLD after
    ADAPTIVE_MIN_QUESTIONS have been answered (the estimate has converged),
whichever comes first — mirroring how real adaptive tests (e.g. GRE, Duolingo
English Test) terminate early once a candidate's level is confidently pinned down.

Coding items are offered once a topic's theta rises into the "medium"/"hard" band;
since there's no code-execution sandbox in this service, submissions are graded by
an LLM against a rubric (falls back to a heuristic length/keyword check if no LLM
provider is configured, so the endpoint never hard-fails).

=== Bayesian Knowledge Tracing (BKT) layer ===

Alongside IRT theta (a continuous ability estimate used to pick the next item), each
topic now also carries a Bayesian Knowledge Tracing state: P(L) = the probability the
student has actually *mastered* the underlying skill, in the classic Corbett & Anderson
(1995) 2-state HMM formulation:

    P(L_t | correct)   = P(L_t)(1-slip) / [P(L_t)(1-slip) + (1-P(L_t))*guess]
    P(L_t | incorrect) = P(L_t)*slip    / [P(L_t)*slip    + (1-P(L_t))*(1-guess)]
    P(L_{t+1})          = P(L_t | evidence) + (1 - P(L_t | evidence)) * transit

IRT and BKT are answering different questions and neither replaces the other:
  - theta (IRT):  "how hard a question can this student handle?" -> drives item selection.
  - p_know (BKT): "has this specific skill actually been learned?" -> drives instructional
    decisions (declare mastery / flag for remediation / recommend next action).

IMPORTANT — honesty about the parameters: p_init/p_transit/p_slip/p_guess below are
literature-standard defaults (Corbett & Anderson's original values, widely reused as
priors in ITS research), NOT parameters fit to this deployment's own data. With only an
in-memory session store and a 38-item bank there isn't yet enough labeled interaction
history to run EM/brute-force parameter fitting per skill. This is a documented baseline,
not a claimed-precise learned model — see `BKT_PARAMS` below and `fit_bkt_params_stub()`
for the (currently unimplemented) upgrade path once real longitudinal response logs exist
in Postgres.
"""
import json
import math
import time
import uuid
from pathlib import Path
from typing import Optional

from app.config import get_settings
from app.services.llm_providers import call_llm, parse_json_loose, LLMError

settings = get_settings()

_BANK_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "adaptive_question_bank.json"
with open(_BANK_PATH, "r") as _f:
    _BANK = json.load(_f)

MCQ_ITEMS = _BANK["mcq"]
CODING_PROMPTS = _BANK["coding_prompts"]
TOPICS = sorted({item["topic"] for item in MCQ_ITEMS})

# In-memory session store: {session_id: state dict}. A Redis/DB swap is a one-function change
# (get/set on this dict) if you need multi-instance deployments — kept simple for the demo.
_SESSIONS: dict[str, dict] = {}


def _level_for_theta(theta: float) -> str:
    if theta < -1.0:
        return "Beginner"
    if theta < 0.25:
        return "Intermediate"
    if theta < 1.25:
        return "Advanced"
    return "Expert"


def _prob_correct(theta: float, b: float) -> float:
    x = max(-30.0, min(30.0, theta - b))
    return 1.0 / (1.0 + math.exp(-x))


# ---- Bayesian Knowledge Tracing (BKT) ----
# Literature-standard priors (Corbett & Anderson 1995-style), applied uniformly across
# topics for now. See module docstring for why these are documented defaults, not fit
# parameters. Split by evidence type: guessing your way to a correct answer is far more
# likely on a 4-option MCQ than on a rubric-graded coding submission.
BKT_PARAMS = {
    "p_init": 0.30,          # prior P(already knows the skill) before any evidence this session
    "p_transit": 0.12,       # P(learns the skill) per practice opportunity, if not yet known
    "p_slip_mcq": 0.10,      # P(wrong despite knowing it) on an MCQ
    "p_guess_mcq": 0.22,     # P(right despite not knowing it) on a 4-option MCQ
    "p_slip_coding": 0.15,   # P(graded wrong despite knowing it) on a coding rubric — slightly
                              # higher than MCQ slip since small implementation bugs happen even
                              # to students who understand the concept
    "p_guess_coding": 0.04,  # P(graded right despite not knowing it) — guessing your way to a
                              # passing rubric score on free-form code is rare
}

BKT_MASTERY_THRESHOLD = 0.95     # standard ITS convention (e.g. Cognitive Tutor "mastery learning")
BKT_NONMASTERY_FLOOR = 0.05      # symmetric floor: confidently NOT known


def _bkt_update(p_know: float, correct: bool, p_slip: float, p_guess: float,
                 p_transit: float = None) -> float:
    """One Bayesian update + learning-transition step. Returns the new P(knows the skill)."""
    p_transit = BKT_PARAMS["p_transit"] if p_transit is None else p_transit
    if correct:
        numerator = p_know * (1 - p_slip)
        denominator = numerator + (1 - p_know) * p_guess
    else:
        numerator = p_know * p_slip
        denominator = numerator + (1 - p_know) * (1 - p_guess)
    p_post = numerator / denominator if denominator > 1e-9 else p_know
    p_next = p_post + (1 - p_post) * p_transit
    return max(0.001, min(0.999, p_next))


def _mastery_status(p_know: float) -> str:
    if p_know < 0.4:
        return "Not Started"
    if p_know < 0.7:
        return "Developing"
    if p_know < BKT_MASTERY_THRESHOLD:
        return "Approaching Mastery"
    return "Mastered"


def fit_bkt_params_stub(topic: str) -> dict:
    """Upgrade path, intentionally NOT implemented: once real per-student, per-topic response
    logs are persisted (see backend Result table / a future LearningEvent model), replace this
    with EM (Baum-Welch) or brute-force grid search over (p_init, p_transit, p_slip, p_guess)
    maximizing held-out log-likelihood, per topic. Returning the documented defaults keeps the
    system honest about what is/isn't data-driven yet, per the project's no-fake-ML rule."""
    return dict(BKT_PARAMS)


def _update_theta(theta: float, se: float, b: float, correct: bool) -> tuple[float, float]:
    """One Newton step of ability re-estimation under the Rasch model, with a step-size
    cap so a single early item can't swing theta wildly (keeps the walk stable with few items)."""
    p = _prob_correct(theta, b)
    info = p * (1 - p) or 1e-4  # Fisher information for this item
    score = (1 if correct else 0) - p
    step = score / (info * 4)  # damping factor — trades convergence speed for stability
    step = max(-0.75, min(0.75, step))
    new_theta = theta + step
    new_theta = max(-3.0, min(3.0, new_theta))
    # SE shrinks as more information accumulates; approximate as 1/sqrt(sum info)
    new_se = 1.0 / math.sqrt((1.0 / (se ** 2 if se > 0 else 1.0)) + info)
    return new_theta, new_se


def _pick_next_item(theta: float, topic: str, used_ids: set[str]) -> Optional[dict]:
    candidates = [it for it in MCQ_ITEMS if it["topic"] == topic and it["id"] not in used_ids]
    if not candidates:
        return None
    return min(candidates, key=lambda it: abs(it["b"] - theta))


def _difficulty_tier(theta: float) -> str:
    if theta < -0.4:
        return "easy"
    if theta < 0.8:
        return "medium"
    return "hard"


def start_session(topics: list[str], include_coding: bool = True, max_questions: Optional[int] = None) -> dict:
    topics = [t for t in topics if t in TOPICS] or TOPICS[:3]
    session_id = str(uuid.uuid4())
    state = {
        "id": session_id,
        "created_at": time.time(),
        "topics": topics,
        "include_coding": include_coding,
        "max_questions": min(max_questions or settings.ADAPTIVE_MAX_QUESTIONS, 30),
        "topic_state": {t: {"theta": 0.0, "se": 1.0, "answered": 0, "correct": 0, "used_ids": [],
                             "p_know": BKT_PARAMS["p_init"]} for t in topics},
        "history": [],
        "asked_coding_for": [],
        "finished": False,
        "current_topic_idx": 0,
    }
    _SESSIONS[session_id] = state
    first_item = _serve_next(state)
    return {"session_id": session_id, "topics": topics, "next": first_item,
            "progress": {"answered": 0, "max_questions": state["max_questions"]}}


def _serve_next(state: dict) -> Optional[dict]:
    """Round-robins across topics, always requesting the item closest to that topic's theta."""
    n_topics = len(state["topics"])
    for offset in range(n_topics):
        idx = (state["current_topic_idx"] + offset) % n_topics
        topic = state["topics"][idx]
        ts = state["topic_state"][topic]
        used = set(ts["used_ids"])
        item = _pick_next_item(ts["theta"], topic, used)
        if item:
            state["current_topic_idx"] = (idx + 1) % n_topics
            return {"type": "mcq", "id": item["id"], "topic": topic, "question": item["q"],
                    "options": item["options"], "difficulty_tier": _difficulty_tier(ts["theta"])}
    return None


def submit_answer(session_id: str, item_id: str, selected_index: int) -> dict:
    state = _SESSIONS.get(session_id)
    if not state:
        raise KeyError("Unknown or expired diagnostic session.")
    item = next((it for it in MCQ_ITEMS if it["id"] == item_id), None)
    if not item:
        raise ValueError(f"Unknown item id: {item_id}")
    topic = item["topic"]
    ts = state["topic_state"][topic]
    correct = selected_index == item["answer"]
    ts["theta"], ts["se"] = _update_theta(ts["theta"], ts["se"], item["b"], correct)
    ts["p_know"] = _bkt_update(ts["p_know"], correct, BKT_PARAMS["p_slip_mcq"], BKT_PARAMS["p_guess_mcq"])
    ts["answered"] += 1
    ts["correct"] += 1 if correct else 0
    ts["used_ids"].append(item_id)
    state["history"].append({"item_id": item_id, "topic": topic, "correct": correct,
                              "theta_after": round(ts["theta"], 3), "p_know_after": round(ts["p_know"], 3)})

    total_answered = sum(t["answered"] for t in state["topic_state"].values())
    # A topic is "resolved" once EITHER model is confident: the IRT ability estimate has
    # converged (low SE) OR BKT has crossed the mastery/non-mastery threshold. The two models
    # can disagree (e.g. a student who guesses well on easy items but hasn't truly mastered the
    # skill) — requiring only one to converge keeps sessions short without hiding that disagreement,
    # since both raw numbers are still returned in the report either way.
    def _topic_resolved(t: dict) -> bool:
        if t["answered"] == 0:
            return True
        se_ok = t["se"] <= settings.ADAPTIVE_SE_THRESHOLD
        bkt_ok = t["p_know"] >= BKT_MASTERY_THRESHOLD or t["p_know"] <= BKT_NONMASTERY_FLOOR
        return se_ok or bkt_ok

    converged = total_answered >= settings.ADAPTIVE_MIN_QUESTIONS and all(
        _topic_resolved(t) for t in state["topic_state"].values()
    )
    done = total_answered >= state["max_questions"] or converged

    result = {
        "correct": correct,
        "correct_answer_index": item["answer"],
        "topic": topic,
        "theta": round(ts["theta"], 3),
        "standard_error": round(ts["se"], 3),
        "level": _level_for_theta(ts["theta"]),
        "p_know": round(ts["p_know"], 3),
        "mastery_status": _mastery_status(ts["p_know"]),
        "progress": {"answered": total_answered, "max_questions": state["max_questions"]},
        "session_finished": done,
    }

    if done:
        state["finished"] = True
        result["report"] = build_report(state)
        return result

    # Offer a coding challenge instead of another MCQ once a topic's ability rises into
    # medium/hard territory and we haven't already offered one for that topic this session.
    tier = _difficulty_tier(ts["theta"])
    if state["include_coding"] and tier in ("medium", "hard") and topic in CODING_PROMPTS \
            and topic not in state["asked_coding_for"]:
        state["asked_coding_for"].append(topic)
        result["next"] = {"type": "coding", "topic": topic, "difficulty_tier": tier,
                           "prompt": CODING_PROMPTS[topic][tier]}
    else:
        result["next"] = _serve_next(state)
        if result["next"] is None:
            # Ran out of unused items for every topic — end gracefully.
            state["finished"] = True
            result["session_finished"] = True
            result["report"] = build_report(state)

    return result


_CODING_RUBRIC_SYSTEM = """You are a strict but fair technical interviewer grading a candidate's written \
solution to a coding prompt (no code execution available — grade from reading the code/pseudocode). \
Output ONLY strict JSON, no markdown fences, matching:
{"score_0_to_10": number, "correctness_notes": string, "complexity_notes": string, \
"code_quality_notes": string, "verdict": "weak|adequate|strong"}"""


async def submit_coding_answer(session_id: str, topic: str, prompt: str, code: str) -> dict:
    state = _SESSIONS.get(session_id)
    if not state:
        raise KeyError("Unknown or expired diagnostic session.")
    ts = state["topic_state"].get(topic)
    if ts is None:
        raise ValueError(f"Topic {topic} not part of this session.")

    grading: dict
    try:
        user = f"PROMPT:\n{prompt}\n\nCANDIDATE'S SOLUTION:\n{code[:4000]}"
        res = await call_llm(_CODING_RUBRIC_SYSTEM, user, {"jsonMode": True, "maxTokens": 500, "temperature": 0.2})
        grading = parse_json_loose(res["text"])
        grading["graded_by"] = f"llm:{res['provider']}"
    except (LLMError, ValueError, Exception) as exc:  # noqa: BLE001
        # Heuristic offline fallback: never block the assessment on a missing LLM key.
        length_score = min(6, len(code.strip()) // 80)
        has_structure = any(k in code for k in ("def ", "function", "class ", "SELECT", "select"))
        score = length_score + (2 if has_structure else 0)
        grading = {
            "score_0_to_10": min(10, score),
            "correctness_notes": "Offline heuristic grading (no LLM key configured) — review manually.",
            "complexity_notes": "Not evaluated offline.",
            "code_quality_notes": "Structure detected." if has_structure else "Could not detect clear code structure.",
            "verdict": "adequate" if score >= 5 else "weak",
            "graded_by": "offline-heuristic",
            "grading_error": str(exc),
        }

    # A coding item counts as a single, heavily-weighted "hard" response for theta purposes.
    correct = grading.get("score_0_to_10", 0) >= 6
    pseudo_b = 1.0 if _difficulty_tier(ts["theta"]) == "hard" else 0.5
    ts["theta"], ts["se"] = _update_theta(ts["theta"], ts["se"], pseudo_b, correct)
    ts["p_know"] = _bkt_update(ts["p_know"], correct, BKT_PARAMS["p_slip_coding"], BKT_PARAMS["p_guess_coding"])
    ts["answered"] += 1
    ts["correct"] += 1 if correct else 0
    state["history"].append({"item_id": f"coding:{topic}", "topic": topic, "correct": correct,
                              "theta_after": round(ts["theta"], 3), "p_know_after": round(ts["p_know"], 3)})

    return {"grading": grading, "topic": topic, "theta": round(ts["theta"], 3),
            "level": _level_for_theta(ts["theta"]),
            "p_know": round(ts["p_know"], 3), "mastery_status": _mastery_status(ts["p_know"])}


def build_report(state: dict) -> dict:
    per_topic = []
    for topic, ts in state["topic_state"].items():
        if ts["answered"] == 0:
            continue
        theta = ts["theta"]
        p_know = ts["p_know"]
        percentile = round(100 / (1 + math.exp(-1.3 * theta)))  # logistic mapping theta -> ~percentile
        # IRT (theta -> level/percentile) and BKT (p_know -> mastery_status) are independent
        # estimates from different evidence models; they usually agree but can diverge — e.g. a
        # student who nails a couple of easy-to-medium items (theta rises) without yet crossing
        # the mastery threshold on repeated evidence (p_know still "Developing"). Surface both
        # rather than silently collapsing to one number, and flag it explicitly when they disagree
        # so the disagreement itself is legible instead of hidden inside a single blended score.
        irt_says_strong = theta >= 0.25   # "Advanced"/"Expert" boundary, see _level_for_theta
        bkt_says_strong = p_know >= BKT_MASTERY_THRESHOLD
        per_topic.append({
            "topic": topic,
            "level": _level_for_theta(theta),
            "theta": round(theta, 3),
            "standard_error": round(ts["se"], 3),
            "estimated_percentile": percentile,
            "p_know": round(p_know, 3),
            "mastery_status": _mastery_status(p_know),
            "models_agree": irt_says_strong == bkt_says_strong,
            "questions_answered": ts["answered"],
            "accuracy": round(100 * ts["correct"] / ts["answered"], 1),
        })
    per_topic.sort(key=lambda t: t["p_know"])
    weakest = per_topic[0]["topic"] if per_topic else None
    strongest = per_topic[-1]["topic"] if per_topic else None
    overall_theta = sum(t["theta"] for t in per_topic) / len(per_topic) if per_topic else 0.0
    overall_p_know = sum(t["p_know"] for t in per_topic) / len(per_topic) if per_topic else 0.0
    disagreements = [t["topic"] for t in per_topic if not t["models_agree"]]
    return {
        "session_id": state["id"],
        "per_topic": per_topic,
        "overall_level": _level_for_theta(overall_theta),
        "overall_theta": round(overall_theta, 3),
        "overall_mastery": round(overall_p_know, 3),
        "overall_mastery_status": _mastery_status(overall_p_know),
        "weakest_topic": weakest,
        "strongest_topic": strongest,
        "topics_needing_review": disagreements,
        "recommendation": (
            f"Focus your next study block on {weakest} — it's your lowest mastery-probability area right now."
            if weakest else "Not enough data collected — try a longer session."
        ),
        "diagnostic_models": {
            "ability_model": "1-parameter logistic (Rasch/IRT) — drives which item difficulty is served next.",
            "mastery_model": "Bayesian Knowledge Tracing — drives the mastery_status/recommendation fields.",
            "bkt_params_source": "literature-standard priors (Corbett & Anderson 1995-style defaults), "
                                  "not yet fit to this deployment's own response data — see "
                                  "adaptive_engine.fit_bkt_params_stub() for the documented upgrade path.",
        },
        # Full per-response ability trajectory (theta_after / p_know_after each answer, across every
        # topic in answered order) — powers the frontend's "Ability trajectory" chart on the report
        # screen. A pure addition to the response shape: existing consumers that only read per_topic/
        # overall_level/recommendation are completely unaffected by this extra key.
        "history": state["history"],
    }


def get_report(session_id: str) -> dict:
    state = _SESSIONS.get(session_id)
    if not state:
        raise KeyError("Unknown or expired diagnostic session.")
    return build_report(state)


def list_topics() -> list[str]:
    return TOPICS


# ===== NEW: Mastery decay / "Skill Freshness" (spaced-repetition-style forgetting curve) =====
#
# A per-topic theta from a diagnostic session a month ago doesn't mean the same thing today.
# This models a simple Ebbinghaus-style exponential forgetting curve so the frontend can show
# a "freshness" indicator per topic and nudge a re-check before it's stale, instead of the
# dashboard silently trusting an old snapshot forever. Deterministic, no LLM/DB dependency —
# the caller (frontend/backend) supplies each topic's last-practiced timestamp.
import math as _math
from datetime import datetime, timezone

_DECAY_HALF_LIFE_DAYS = 21.0  # theta retains ~50% of its "freshness confidence" after 3 weeks


def _freshness_label(days_since: float) -> str:
    if days_since <= 3:
        return "Fresh"
    if days_since <= 10:
        return "Recent"
    if days_since <= 21:
        return "Aging"
    return "Stale \u2014 consider re-testing"


def mastery_with_decay(theta: float, last_practiced_at: str) -> dict:
    """Given a raw theta and an ISO-8601 timestamp of when it was measured, returns the same
    theta (we never invent a lower ability score) alongside a confidence multiplier and label
    reflecting how stale that measurement likely is."""
    try:
        practiced = datetime.fromisoformat(last_practiced_at.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        practiced = datetime.now(timezone.utc)
    now = datetime.now(timezone.utc)
    days_since = max(0.0, (now - practiced).total_seconds() / 86400)
    confidence = round(0.5 ** (days_since / _DECAY_HALF_LIFE_DAYS), 3)  # 1.0 -> 0.0 over time
    return {
        "theta": theta,
        "level": _level_for_theta(theta),
        "days_since_practiced": round(days_since, 1),
        "freshness_confidence": confidence,
        "freshness_label": _freshness_label(days_since),
    }


def mastery_report_with_decay(entries: list[dict]) -> list[dict]:
    """Batch version for a dashboard: entries = [{topic, theta, last_practiced_at}, ...]."""
    out = []
    for e in entries:
        decayed = mastery_with_decay(e.get("theta", 0.0), e.get("last_practiced_at", ""))
        out.append({"topic": e.get("topic"), **decayed})
    return out
