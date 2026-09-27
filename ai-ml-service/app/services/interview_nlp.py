"""
AI Mock Interviewer — NLP & speech analysis layer.

Two independent signal sources are combined:
  1. Deterministic linguistic analysis (filler words, hedging language, pace, lexicon-based
     sentiment/confidence) — zero dependencies, always available, and gives instantly
     reproducible numbers a student can track improvement against across attempts.
  2. LLM-backed domain-specific feedback (STAR structure, technical depth, adaptive
     follow-up question) — richer but requires a configured provider key; degrades to a
     template-based response if none is set, so the endpoint never hard-fails.
"""
import re
import time
import uuid
from typing import Optional

from app.config import get_settings
from app.services.llm_providers import call_llm, parse_json_loose, LLMError
from app.services import audio_prosody, video_behavioral
from app.services.ai_reliability import check_reliability

settings = get_settings()

FILLER_WORDS = ["um", "uh", "umm", "uhh", "like", "you know", "sort of", "kind of",
                "basically", "actually", "literally", "i mean", "so yeah"]
HEDGE_WORDS = ["maybe", "i think", "i guess", "probably", "not sure", "i'm not sure",
               "kind of", "sort of", "might be", "possibly"]
CONFIDENT_WORDS = ["definitely", "certainly", "confident", "successfully", "achieved",
                    "led", "built", "designed", "improved", "delivered", "owned", "drove"]

# Small hand-curated valence lexicon — deliberately compact; this is meant to catch the
# broad tone (confident/positive vs. uncertain/negative framing of one's own work) rather
# than do general-purpose sentiment analysis.
_POSITIVE = {"improved", "success", "successful", "achieved", "efficient", "effective",
             "great", "strong", "excellent", "proud", "solved", "optimized", "growth",
             "leadership", "led", "collaborated", "delivered", "impact", "confident"}
_NEGATIVE = {"failed", "failure", "difficult", "struggle", "struggled", "confused",
             "problem", "stuck", "worried", "nervous", "bad", "weak", "unsure", "mistake"}

_SESSIONS: dict[str, dict] = {}


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-zA-Z']+", text.lower())


def analyze_transcript(text: str, duration_seconds: Optional[float] = None) -> dict:
    lower = text.lower()
    words = _tokenize(text)
    word_count = len(words)

    filler_count = sum(lower.count(f) for f in FILLER_WORDS)
    hedge_count = sum(lower.count(h) for h in HEDGE_WORDS)
    confident_count = sum(1 for w in words if w in CONFIDENT_WORDS)

    pos_hits = sum(1 for w in words if w in _POSITIVE)
    neg_hits = sum(1 for w in words if w in _NEGATIVE)
    sentiment_raw = pos_hits - neg_hits
    sentiment_score = max(-1.0, min(1.0, sentiment_raw / max(3, word_count / 20)))
    sentiment_label = "positive" if sentiment_score > 0.15 else "negative" if sentiment_score < -0.15 else "neutral"

    filler_rate = filler_count / max(1, word_count) * 100
    hedge_rate = hedge_count / max(1, word_count) * 100

    # Confidence score: starts at 70, penalized by filler/hedge density, rewarded by
    # confident/ownership language and sentence completeness (rough proxy: avg sentence length).
    sentences = [s for s in re.split(r"[.!?]+", text) if s.strip()]
    avg_sentence_len = word_count / max(1, len(sentences))
    confidence = 70.0
    confidence -= min(30, filler_rate * 3)
    confidence -= min(20, hedge_rate * 2.5)
    confidence += min(15, confident_count * 2)
    confidence += 5 if 8 <= avg_sentence_len <= 25 else -5
    confidence = max(0.0, min(100.0, confidence))

    wpm = None
    pace_label = None
    if duration_seconds and duration_seconds > 0:
        wpm = round(word_count / (duration_seconds / 60), 1)
        pace_label = "too fast" if wpm > 170 else "too slow" if wpm < 100 else "good pace"

    return {
        "word_count": word_count,
        "filler_word_count": filler_count,
        "filler_rate_pct": round(filler_rate, 1),
        "hedge_word_count": hedge_count,
        "hedge_rate_pct": round(hedge_rate, 1),
        "confident_phrase_count": confident_count,
        "sentiment": {"label": sentiment_label, "score": round(sentiment_score, 2)},
        "confidence_score_0_100": round(confidence, 1),
        "avg_sentence_length": round(avg_sentence_len, 1),
        "pace": {"words_per_minute": wpm, "assessment": pace_label} if wpm else None,
    }


_FEEDBACK_SYSTEM = """You are an expert technical interview coach. Given an interview question, a \
candidate's spoken/written answer, and the target role/domain, give structured, actionable feedback.
Output ONLY strict JSON, no markdown fences, matching:
{"star_structure_present": boolean, "star_notes": string, "technical_depth_0_10": number, \
"communication_clarity_0_10": number, "strengths": [string] (max 3), "improvements": [string] (max 3), \
"ideal_answer_outline": [string] (max 5, short bullet points), \
"follow_up_question": string (one natural interviewer follow-up probing the weakest part of the answer)}"""


def _offline_feedback(question: str, answer: str, linguistic: dict) -> dict:
    star_present = bool(re.search(r"\b(situation|task|result|when i|i had to)\b", answer, re.I))
    return {
        "star_structure_present": star_present,
        "star_notes": "Detected STAR-style framing." if star_present else
                       "Couldn't detect explicit Situation/Task/Action/Result structure — consider framing with STAR.",
        "technical_depth_0_10": 5,
        "communication_clarity_0_10": max(1, round(10 - linguistic["filler_rate_pct"] / 3)),
        "strengths": ["Answer was substantive."] if linguistic["word_count"] > 40 else ["Answer was concise."],
        "improvements": (
            ["Reduce filler words (um, like, you know)."] if linguistic["filler_rate_pct"] > 3 else []
        ) + (["Sound more decisive — fewer hedges like 'maybe'/'I think'."] if linguistic["hedge_rate_pct"] > 3 else []),
        "ideal_answer_outline": ["State the situation briefly", "Explain your specific action",
                                  "Quantify the result", "Tie it back to the role"],
        "follow_up_question": "Can you walk me through a specific metric or outcome from that experience?",
        "generated_by": "offline-template (no LLM key configured)",
    }


def _feedback_known_facts(question: str, answer: str, linguistic: dict) -> list[str]:
    """Deterministic facts already computed for this request (spec §16 pattern, matching
    career_path.py/roadmap.py): the candidate's own answer/question text plus the
    linguistic-analysis numbers, so LLM coaching commentary can be checked against what the
    candidate actually said rather than treated as free-floating prose."""
    facts = [f"INTERVIEW QUESTION: {question}", f"CANDIDATE ANSWER: {answer[:4000]}"]
    if linguistic.get("pace"):
        facts.append(f"Speaking pace: {linguistic['pace']['words_per_minute']} words per minute "
                     f"({linguistic['pace']['assessment']}).")
    facts.append(f"Filler word rate: {linguistic['filler_rate_pct']}%. "
                 f"Hedge word rate: {linguistic['hedge_rate_pct']}%. "
                 f"Confident phrase count: {linguistic['confident_phrase_count']}.")
    facts.append(f"Overall sentiment: {linguistic['sentiment']['label']}. "
                 f"Deterministic confidence score: {linguistic['confidence_score_0_100']}/100.")
    return facts


def _feedback_free_text(feedback: dict) -> str:
    """Concatenates the qualitative, hallucination-prone parts of the LLM feedback (not the
    numeric scores) into one blob for check_reliability's claim extraction.

    star_notes/strengths are descriptive ("you did X") — the fields where an invented specific
    is most misleading. improvements/outline/follow_up are prescriptive ("mention X next
    time") — still worth checking for invented specifics (e.g. praising a technology the
    candidate never used), but each item is usually a short imperative fragment, and
    ai_reliability's notable-term check can mistake an ordinary sentence-initial capitalized
    verb ("Describe...", "Reflect...") for a proper noun. Lower-casing each fragment's first
    letter avoids that false positive without touching the shared checker used by
    career_path.py/roadmap.py.
    """
    def _decap(s: str) -> str:
        return s[:1].lower() + s[1:] if s else s

    parts = []
    if feedback.get("star_notes"):
        parts.append(str(feedback["star_notes"]))
    parts.extend(str(s) for s in feedback.get("strengths") or [])
    parts.extend(_decap(str(s)) for s in feedback.get("improvements") or [])
    parts.extend(_decap(str(s)) for s in feedback.get("ideal_answer_outline") or [])
    if feedback.get("follow_up_question"):
        parts.append(_decap(str(feedback["follow_up_question"])))
    return " ".join(p if p.endswith((".", "?", "!")) else p + "." for p in parts)


async def evaluate_answer(question: str, answer: str, role: Optional[str] = None,
                           duration_seconds: Optional[float] = None) -> dict:
    linguistic = analyze_transcript(answer, duration_seconds)
    llm_used = False
    try:
        user = f"ROLE/DOMAIN: {role or 'general software role'}\nQUESTION: {question}\nCANDIDATE ANSWER:\n{answer[:4000]}"
        res = await call_llm(_FEEDBACK_SYSTEM, user, {"jsonMode": True, "maxTokens": 700, "temperature": 0.4})
        feedback = parse_json_loose(res["text"])
        feedback["generated_by"] = f"llm:{res['provider']}"
        llm_used = True
    except (LLMError, ValueError, Exception) as exc:  # noqa: BLE001
        feedback = _offline_feedback(question, answer, linguistic)
        feedback["llm_error"] = str(exc)

    # AI Reliability layer (spec §16): only meaningful for LLM-generated text — the offline
    # template above is built deterministically from the answer itself, so checking it would
    # be circular (same reasoning as career_path.py/roadmap.py).
    if llm_used:
        known_facts = _feedback_known_facts(question, answer, linguistic)
        reliability = check_reliability(_feedback_free_text(feedback), known_facts)
        feedback["reliability"] = reliability
        if reliability.get("confidence_label") == "low":
            # Preserve the useful feedback but make the uncertainty explicit instead of
            # presenting unsupported technology/experience claims as established facts.
            feedback["uncertainty_warning"] = (
                "Some qualitative AI feedback could not be grounded in the candidate's "
                "answer or deterministic interview measurements. Verify those statements "
                "before acting on them."
            )

    return {"linguistic_analysis": linguistic, "feedback": feedback}


# ===== NEW: Competency rubric breakdown =====
#
# Deepens the existing evaluate_answer() output: recombines the linguistic analysis +
# LLM/offline feedback that already exist into four named competency scores (0-100), which
# is what the frontend's summary screen actually wants to chart per-competency rather than a
# handful of loosely related numbers. No new LLM call — pure recombination of data already
# computed by evaluate_answer(), so it costs nothing extra beyond the existing call.
def _clamp(v: float, lo: float = 0, hi: float = 100) -> float:
    return max(lo, min(hi, v))


def rubric_breakdown(evaluation: dict) -> dict:
    ling = evaluation.get("linguistic_analysis", {})
    fb = evaluation.get("feedback", {})

    communication = _clamp(
        0.5 * ling.get("confidence_score_0_100", 50)
        + 0.5 * (fb.get("communication_clarity_0_10", 5) * 10)
    )
    technical_depth = _clamp(fb.get("technical_depth_0_10", 5) * 10)
    problem_solving = _clamp(70 if fb.get("star_structure_present") else 45)
    confidence = _clamp(
        ling.get("confidence_score_0_100", 50)
        - ling.get("hedge_rate_pct", 0) * 1.5
    )

    scores = {
        "Communication": round(communication, 1),
        "Technical Depth": round(technical_depth, 1),
        "Problem Solving (STAR)": round(problem_solving, 1),
        "Confidence": round(confidence, 1),
    }
    overall = round(sum(scores.values()) / len(scores), 1)
    weakest = min(scores, key=scores.get)
    return {"competencies": scores, "overall_0_100": overall, "weakest_competency": weakest}


# ---------------------------------------------------------------------------
# Multi-turn adaptive interview session (question -> answer -> follow-up -> ...)
# ---------------------------------------------------------------------------

_STARTER_QUESTIONS = {
    "software engineer": "Tell me about a project where you had to make a tough technical trade-off.",
    "data scientist": "Walk me through a time you had to explain a model's results to a non-technical stakeholder.",
    "product manager": "Tell me about a time you had to prioritize between two competing feature requests.",
    "default": "Tell me about yourself and a project you're proud of.",
}


def start_interview_session(role: str, domain_focus: Optional[str] = None) -> dict:
    session_id = str(uuid.uuid4())
    question = _STARTER_QUESTIONS.get((role or "").strip().lower(), _STARTER_QUESTIONS["default"])
    state = {
        "id": session_id,
        "created_at": time.time(),
        "role": role,
        "domain_focus": domain_focus,
        "turns": [],
        "current_question": question,
    }
    _SESSIONS[session_id] = state
    return {"session_id": session_id, "question": question, "turn": 1}


async def respond_in_session(session_id: str, answer: str, duration_seconds: Optional[float] = None) -> dict:
    state = _SESSIONS.get(session_id)
    if not state:
        raise KeyError("Unknown or expired interview session.")

    question = state["current_question"]
    evaluation = await evaluate_answer(question, answer, state["role"], duration_seconds)
    state["turns"].append({"question": question, "answer": answer, "evaluation": evaluation})

    next_question = evaluation["feedback"].get("follow_up_question") or "What would you do differently next time?"
    finished = len(state["turns"]) >= settings.INTERVIEW_MAX_FOLLOWUPS
    if not finished:
        state["current_question"] = next_question

    result = {
        "evaluation": evaluation,
        "turn": len(state["turns"]),
        "session_finished": finished,
    }
    if finished:
        result["session_summary"] = _summarize_session(state)
    else:
        result["next_question"] = next_question
    return result


# ---------------------------------------------------------------------------
# Multimodal Interview Intelligence (spec §10) — TEXT + AUDIO + VIDEO + interview context.
#
# Deliberately implemented as a thin wrapper around respond_in_session() rather than a
# parallel evaluation path: the technical/language rubric (evaluate_answer -> rubric_breakdown
# above) is unchanged and computed exactly the same way whether or not audio/video was
# supplied — this function only *attaches* the new speech-prosody and visual-behavior blocks
# alongside it. They are intentionally NOT merged into competency_rubric's numeric scores:
# per spec §10's explicit instruction, facial/gaze/posture signals must never be presented as
# a measure of competence, so folding them into a 0-100 "Confidence" or "Communication" score
# would misrepresent an unvalidated heuristic as a calibrated one. Documented research
# limitation (§33) rather than a fabricated fusion weight.
async def respond_in_session_multimodal(
    session_id: str,
    answer: str,
    duration_seconds: Optional[float] = None,
    audio_bytes: Optional[bytes] = None,
    audio_filename: Optional[str] = None,
    video_bytes: Optional[bytes] = None,
    video_filename: Optional[str] = None,
) -> dict:
    result = await respond_in_session(session_id, answer, duration_seconds)

    speech_prosody = (
        audio_prosody.analyze_prosody(audio_bytes, audio_filename or "answer.webm", duration_seconds)
        if audio_bytes else None
    )
    visual_behavior = (
        video_behavioral.analyze_video_behavior(video_bytes, video_filename or "answer.webm")
        if video_bytes else None
    )
    result["speech_prosody"] = speech_prosody
    result["visual_behavior"] = visual_behavior

    # Stash on the just-appended turn record too, so a finished session's summary (below) can
    # roll these up across the whole interview, not just report the final turn's numbers.
    state = _SESSIONS.get(session_id)
    if state and state["turns"]:
        state["turns"][-1]["speech_prosody"] = speech_prosody
        state["turns"][-1]["visual_behavior"] = visual_behavior
        # session_summary was already built inside respond_in_session() before this turn's
        # multimodal data was attached — rebuild it now so a finished session's summary
        # actually includes this turn's behavioral_indicators_summary.
        if result.get("session_finished"):
            result["session_summary"] = _summarize_session(state)

    return result


def _summarize_session(state: dict) -> dict:
    turns = state["turns"]
    avg_confidence = sum(t["evaluation"]["linguistic_analysis"]["confidence_score_0_100"] for t in turns) / len(turns)
    avg_depth = sum(t["evaluation"]["feedback"].get("technical_depth_0_10", 5) for t in turns) / len(turns)
    avg_clarity = sum(t["evaluation"]["feedback"].get("communication_clarity_0_10", 5) for t in turns) / len(turns)
    all_improvements = [imp for t in turns for imp in t["evaluation"]["feedback"].get("improvements", [])]

    # Deepened: average the per-turn competency rubric (see rubric_breakdown() above) across
    # the whole session, so the summary screen can chart Communication/Technical
    # Depth/Problem Solving/Confidence trends rather than only the three loose averages above.
    per_turn_rubrics = [rubric_breakdown(t["evaluation"]) for t in turns]
    competency_keys = per_turn_rubrics[0]["competencies"].keys()
    avg_rubric = {
        k: round(sum(r["competencies"][k] for r in per_turn_rubrics) / len(per_turn_rubrics), 1)
        for k in competency_keys
    }
    overall_rubric_score = round(sum(avg_rubric.values()) / len(avg_rubric), 1)
    weakest = min(avg_rubric, key=avg_rubric.get)

    summary = {
        "turns_completed": len(turns),
        "avg_confidence_score_0_100": round(avg_confidence, 1),
        "avg_technical_depth_0_10": round(avg_depth, 1),
        "avg_communication_clarity_0_10": round(avg_clarity, 1),
        "recurring_improvements": sorted(set(all_improvements), key=all_improvements.count, reverse=True)[:5],
        "competency_rubric": avg_rubric,
        "overall_rubric_score_0_100": overall_rubric_score,
        "weakest_competency": weakest,
    }

    # Behavioral indicators (spec §10) are rolled up SEPARATELY from competency_rubric above —
    # never averaged into it — since they're unvalidated heuristics, not measured competence.
    # Only included at all if at least one turn actually had audio/video attached (multimodal
    # is optional; a text-only session's summary shouldn't carry a block full of nulls).
    prosody_turns = [t["speech_prosody"] for t in turns if t.get("speech_prosody", {}).get("available")]
    visual_turns = [t["visual_behavior"] for t in turns if t.get("visual_behavior", {}).get("available")]
    if prosody_turns or visual_turns:
        behavioral = {}
        if prosody_turns:
            behavioral["avg_pause_count_per_turn"] = round(
                sum(p["pauses"]["pause_count"] for p in prosody_turns) / len(prosody_turns), 1)
            speech_ratios = [p["pauses"]["speech_ratio"] for p in prosody_turns if p["pauses"]["speech_ratio"] is not None]
            behavioral["avg_speech_ratio"] = round(sum(speech_ratios) / len(speech_ratios), 3) if speech_ratios else None
            monotone_turns = sum(1 for p in prosody_turns if p["pitch"].get("relatively_monotone_delivery"))
            behavioral["monotone_delivery_in_turns"] = f"{monotone_turns}/{len(prosody_turns)}"
        if visual_turns:
            behavioral["avg_face_presence_ratio"] = round(
                sum(v["face_presence_ratio"] for v in visual_turns) / len(visual_turns), 3)
            gaze_vals = [v["gaze_toward_camera_ratio"] for v in visual_turns if v["gaze_toward_camera_ratio"] is not None]
            behavioral["avg_gaze_toward_camera_ratio"] = round(sum(gaze_vals) / len(gaze_vals), 3) if gaze_vals else None
        behavioral["caveats"] = [
            "These are acoustic/visual behavioral indicators only, aggregated across the turns "
            "that had audio/video attached — NOT part of the competency_rubric above and NOT a "
            "measure of intelligence, honesty, personality, mental state, or competence.",
        ]
        summary["behavioral_indicators_summary"] = behavioral

    return summary
