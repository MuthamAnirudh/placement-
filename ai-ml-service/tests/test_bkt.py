"""
Unit tests for the Bayesian Knowledge Tracing layer added to adaptive_engine.py.

Pure-function tests only (no FastAPI/httpx/session-store dependency), so these run with
plain `pytest` and no service needs to be booted. Run from ai-ml-service/:

    pytest tests/test_bkt.py -v
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.adaptive_engine import (  # noqa: E402
    _bkt_update, _mastery_status, BKT_PARAMS, BKT_MASTERY_THRESHOLD, BKT_NONMASTERY_FLOOR,
)


def test_bkt_update_increases_on_correct():
    p0 = BKT_PARAMS["p_init"]
    p1 = _bkt_update(p0, True, BKT_PARAMS["p_slip_mcq"], BKT_PARAMS["p_guess_mcq"])
    assert p1 > p0, "A correct answer should raise P(knows the skill)."


def test_bkt_update_decreases_on_incorrect():
    p0 = 0.6
    p1 = _bkt_update(p0, False, BKT_PARAMS["p_slip_mcq"], BKT_PARAMS["p_guess_mcq"])
    assert p1 < p0, "An incorrect answer should lower P(knows the skill)."


def test_bkt_p_know_stays_in_bounds():
    p = BKT_PARAMS["p_init"]
    for _ in range(50):
        p = _bkt_update(p, True, BKT_PARAMS["p_slip_mcq"], BKT_PARAMS["p_guess_mcq"])
        assert 0.0 < p < 1.0
    for _ in range(50):
        p = _bkt_update(p, False, BKT_PARAMS["p_slip_mcq"], BKT_PARAMS["p_guess_mcq"])
        assert 0.0 < p < 1.0


def test_repeated_correct_answers_converge_toward_mastery():
    p = BKT_PARAMS["p_init"]
    for _ in range(20):
        p = _bkt_update(p, True, BKT_PARAMS["p_slip_mcq"], BKT_PARAMS["p_guess_mcq"])
    assert p >= BKT_MASTERY_THRESHOLD, f"Expected convergence to mastery, got {p}"
    assert _mastery_status(p) == "Mastered"


def test_repeated_incorrect_answers_converge_toward_non_mastery():
    p = BKT_PARAMS["p_init"]
    for _ in range(20):
        p = _bkt_update(p, False, BKT_PARAMS["p_slip_mcq"], BKT_PARAMS["p_guess_mcq"])
    # p_transit means p_know never fully collapses to 0 (there's always some chance of
    # learning on the next opportunity) — so this checks "very low", not "at the floor".
    assert p < 0.3, f"Expected p_know to stay low after repeated misses, got {p}"
    assert _mastery_status(p) in ("Not Started", "Developing")


def test_correct_coding_answer_is_stronger_evidence_than_correct_mcq():
    # The guess parameter's effect on the posterior shows up on CORRECT answers (it appears
    # in the denominator only when correct=True): guessing your way to a passing rubric score
    # on free-form code is much rarer than guessing a 4-option MCQ, so a correct coding
    # submission should raise p_know more than a correct MCQ answer does, from the same prior.
    p0 = 0.5
    p_after_correct_mcq = _bkt_update(p0, True, BKT_PARAMS["p_slip_mcq"], BKT_PARAMS["p_guess_mcq"])
    p_after_correct_coding = _bkt_update(p0, True, BKT_PARAMS["p_slip_coding"], BKT_PARAMS["p_guess_coding"])
    assert p_after_correct_coding > p_after_correct_mcq


def test_mastery_status_thresholds():
    assert _mastery_status(0.1) == "Not Started"
    assert _mastery_status(0.5) == "Developing"
    assert _mastery_status(0.8) == "Approaching Mastery"
    assert _mastery_status(0.97) == "Mastered"


def test_bkt_update_handles_degenerate_p_know_zero():
    # p_know=0 with p_guess=0 would divide by zero on an incorrect answer; must not crash.
    p = _bkt_update(0.0, False, p_slip=0.0, p_guess=0.0)
    assert 0.0 <= p <= 1.0
