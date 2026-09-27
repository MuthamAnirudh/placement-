"""
Peer Percentile Benchmarking.

New capability enabled by the backend's persistence layer: once quiz/interview/roadmap/
radar results are saved to Postgres (backend/src/routes/results.js), the frontend can pull
an anonymized array of everyone's scores for a given result type/topic
(`GET /api/results/peer-stats`, no names or user IDs — just numbers) and hand it to this
service to answer "where do I actually stand?"

This service stays stateless and dependency-free on purpose (same design principle as
market_intel.py's offline-first dataset): it never talks to the database itself, it just
does the statistics on whatever score list it's given. That keeps ai-ml-service deployable
completely independently of the Node backend / Postgres, and keeps user data out of it
entirely — it only ever sees numbers.
"""
import math
from typing import Optional


def _percentile_rank(value: float, sorted_scores: list[float]) -> float:
    """% of peers this value is greater than or equal to (100 = better than everyone)."""
    if not sorted_scores:
        return 50.0
    n = len(sorted_scores)
    below_or_equal = sum(1 for s in sorted_scores if s <= value)
    return round(100 * below_or_equal / n, 1)


def _decile(percentile: float) -> int:
    return min(10, max(1, math.ceil(percentile / 10) or 1))


def _histogram(sorted_scores: list[float], bucket_count: int = 10) -> list[dict]:
    if not sorted_scores:
        return []
    lo, hi = sorted_scores[0], sorted_scores[-1]
    if lo == hi:
        return [{"range": f"{lo:.0f}", "count": len(sorted_scores)}]
    width = (hi - lo) / bucket_count
    buckets = [0] * bucket_count
    for s in sorted_scores:
        idx = min(bucket_count - 1, int((s - lo) / width)) if width > 0 else 0
        buckets[idx] += 1
    return [
        {"range": f"{lo + i * width:.0f}\u2013{lo + (i + 1) * width:.0f}", "count": c}
        for i, c in enumerate(buckets)
    ]


def compute_percentile(user_score: float, peer_scores: list[float]) -> dict:
    scores = sorted(s for s in peer_scores if s is not None)
    n = len(scores)
    if n == 0:
        return {
            "percentile": None,
            "decile": None,
            "z_score": None,
            "peer_count": 0,
            "label": "Not enough peer data yet \u2014 be the first to set the benchmark!",
            "histogram": [],
            "mean": None,
            "median": None,
        }

    mean = sum(scores) / n
    variance = sum((s - mean) ** 2 for s in scores) / n
    stdev = math.sqrt(variance)
    z = round((user_score - mean) / stdev, 2) if stdev > 0 else 0.0
    percentile = _percentile_rank(user_score, scores)
    median = scores[n // 2] if n % 2 == 1 else (scores[n // 2 - 1] + scores[n // 2]) / 2

    if percentile >= 90:
        label = "Top 10% \u2014 exceptional performance among your peers."
    elif percentile >= 75:
        label = "Top quartile \u2014 well above average."
    elif percentile >= 50:
        label = "Above the median."
    elif percentile >= 25:
        label = "Below the median \u2014 room to close the gap."
    else:
        label = "Bottom quartile \u2014 this is a good area to focus on next."

    return {
        "percentile": percentile,
        "decile": _decile(percentile),
        "z_score": z,
        "peer_count": n,
        "label": label,
        "histogram": _histogram(scores),
        "mean": round(mean, 1),
        "median": round(median, 1),
        "your_score": user_score,
    }
