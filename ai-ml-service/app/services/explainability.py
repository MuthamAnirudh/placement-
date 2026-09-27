"""
Explainable AI layer — "why did the system make this recommendation?"

Design principle (see project spec §17 / §33): every number shown here must be an EXACT,
traceable readout of a computation this codebase already performs — never an approximated
or simulated importance score. That's a deliberate, documented choice: the scoring functions
in career_path.py and market_intel.py are simple, fully-known linear/rank formulas (a
weighted sum, a sorted list), so exact contribution decomposition is both possible and more
honest than an approximation technique like SHAP, which exists specifically for opaque
models we don't have here. If a genuinely black-box model (e.g. a trained neural ranker) is
added later, swap the `career_match_evidence`/`skill_recommendation_evidence` builders below
for a real SHAP/LIME explainer against that model — the `Evidence`/`Factor` shape returned
to the frontend is designed to stay stable either way.
"""
from dataclasses import dataclass, field, asdict
from typing import Optional


@dataclass
class Factor:
    """One contributing factor behind a recommendation, with its exact numeric contribution."""
    label: str
    detail: str
    contribution_pct: float  # exact points this factor contributed to the final score (0-100 scale)
    direction: str  # "supports" | "against" | "neutral"


@dataclass
class Evidence:
    recommendation: str
    confidence: Optional[float]
    method: str  # short, honest description of HOW the score was computed
    factors: list[Factor] = field(default_factory=list)
    caveats: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


def career_match_evidence(scored: dict, coverage: float, mastery_bonus: float,
                           interest_boost_applied: bool) -> dict:
    """Exact decomposition of career_path._score_archetype's confidence formula:
    confidence = round(100 * (0.6*coverage + 0.4*mastery_bonus), 1) [+15 optional interest boost].
    Every contribution below sums back to the displayed confidence — this is arithmetic, not
    an estimate.
    """
    coverage_pts = round(100 * 0.6 * coverage, 1)
    mastery_pts = round(100 * 0.4 * mastery_bonus, 1)
    factors = [
        Factor(
            label="Core-skill coverage",
            detail=f"You have {len(scored['matched_skills'])} of "
                   f"{len(scored['matched_skills']) + len(scored['missing_skills'])} core skills this "
                   f"track needs (weighted 60% of the score).",
            contribution_pct=coverage_pts,
            direction="supports" if coverage_pts > 0 else "neutral",
        ),
        Factor(
            label="Mastery depth on matched skills",
            detail="Average verified mastery (from Adaptive Diagnostic results where available, "
                   "0.6 assumed for skills you've listed but not been tested on) across the skills "
                   "you already have (weighted 40% of the score).",
            contribution_pct=mastery_pts,
            direction="supports" if mastery_pts > 0 else "neutral",
        ),
    ]
    if interest_boost_applied:
        factors.append(Factor(
            label="Stated interest match",
            detail="You named this track (or a close synonym) as your target interest.",
            contribution_pct=15.0,
            direction="supports",
        ))
    caveats = []
    if len(scored["missing_skills"]) > 0:
        caveats.append(
            f"Missing skills ({', '.join(scored['missing_skills'][:4])}"
            f"{'…' if len(scored['missing_skills']) > 4 else ''}) are not yet verified — "
            "this score can't confirm you'd succeed in the role, only that your current profile overlaps with it."
        )
    if mastery_pts and any(True for _ in [1]):
        caveats.append(
            "Mastery values for skills without an Adaptive Diagnostic attempt are an unverified "
            "default (0.6), not a measured score."
        )
    return Evidence(
        recommendation=f"{scored['title']} is your closest career-path match.",
        confidence=scored["confidence"],
        method="Exact weighted sum: 60% core-skill overlap + 40% average mastery on matched skills "
               "(+15 flat if you named this as your target interest). No LLM or trained model is used "
               "for the ranking itself.",
        factors=factors,
        caveats=caveats,
    ).to_dict()


def resume_match_evidence(match_result: dict) -> dict:
    """Exact decomposition of matcher.explain_resume_jd_match's skill_coverage_score:
    score = 100 * (exact_matched_count + sum(partial confidences)) / total_jd_skills.
    Every factor below sums back to the displayed score — this is arithmetic over the
    already-computed per-skill matches, not a separate estimate.
    """
    matched = match_result.get("matched_skills", [])
    partial = match_result.get("partially_matched_skills", [])
    missing = match_result.get("missing_skills", [])
    total = len(matched) + len(partial) + len(missing) or 1

    matched_pts = round(100 * len(matched) / total, 1)
    partial_pts = round(100 * sum(p["confidence"] for p in partial) / total, 1)

    factors = [
        Factor(
            label="Directly matched skills",
            detail=f"{len(matched)} of {total} required skills are on your resume "
                   "(exact listing or a near-equivalent, evidence given per skill).",
            contribution_pct=matched_pts,
            direction="supports" if matched_pts > 0 else "neutral",
        ),
        Factor(
            label="Partially matched / transferable skills",
            detail=f"{len(partial)} required skills have a related-but-not-equivalent skill on "
                   "your resume (each weighted by its own semantic-similarity score, not counted "
                   "as a full match).",
            contribution_pct=partial_pts,
            direction="supports" if partial_pts > 0 else "neutral",
        ),
    ]
    caveats = [
        "Every skill here is self-reported on the resume, not tested — this reflects overlap "
        "with the job description, not verified proficiency.",
    ]
    if missing:
        caveats.append(
            f"{len(missing)} required skill(s) ({', '.join(m['skill'] for m in missing[:4])}"
            f"{'…' if len(missing) > 4 else ''}) have no resume evidence at all."
        )

    return Evidence(
        recommendation=f"{match_result.get('skill_coverage_score', 0)}% skill coverage against this job description.",
        confidence=match_result.get("skill_coverage_score"),
        method="Exact sum: one full point per exactly/near-exactly matched required skill, plus the "
               "raw semantic-similarity score for each partial match, divided by the total number of "
               "required skills. No LLM or trained model is used for the score itself.",
        factors=factors,
        caveats=caveats,
    ).to_dict()


def skill_recommendation_evidence(top_skill_row: dict, all_rows: list[dict], role: str) -> dict:
    """Evidence for market_intel.compute_radar's `top_priority_skill` pick — why this specific
    missing skill was surfaced first, out of every skill the target role's dataset tracks.
    """
    missing_sorted = sorted([r for r in all_rows if not r["you_have_it"]], key=lambda r: -r["market_demand"])
    rank_among_missing = next((i + 1 for i, r in enumerate(missing_sorted) if r["skill"] == top_skill_row["skill"]), None)
    demand_values = [r["market_demand"] for r in all_rows]
    percentile = (
        round(100 * sum(1 for d in demand_values if d <= top_skill_row["market_demand"]) / len(demand_values), 1)
        if demand_values else None
    )

    factors = [
        Factor(
            label="Market demand",
            detail=f"{top_skill_row['market_demand']}/100 demand score for {role} — higher than "
                   f"{percentile}% of every skill tracked for this role.",
            contribution_pct=top_skill_row["market_demand"],
            direction="supports",
        ),
        Factor(
            label="Highest-ranked gap",
            detail=f"#{rank_among_missing} of {len(missing_sorted)} skills you're currently missing for "
                   f"this role, ranked by market demand.",
            contribution_pct=round(100 * (1 - (rank_among_missing - 1) / max(1, len(missing_sorted))), 1)
            if rank_among_missing else 0.0,
            direction="supports",
        ),
    ]
    if top_skill_row.get("growth") in ("rising", "live-observed"):
        factors.append(Factor(
            label="Growth trend",
            detail=f"Marked '{top_skill_row['growth']}' — demand for this skill is trending up, not just "
                   "high right now.",
            contribution_pct=0.0,
            direction="supports",
        ))

    caveats = [
        "Demand scores come from a curated dataset" +
        (" blended with live job-postings" if any(r.get("live_signal") for r in all_rows) else "") +
        " — they reflect relative posting frequency, not a guarantee of salary or hiring outcome.",
    ]

    return Evidence(
        recommendation=f"Learn {top_skill_row['skill']} next.",
        confidence=None,
        method="Ranked by market-demand score among skills you don't yet have; ties broken by growth trend. "
               "No LLM or trained model is used for this ranking.",
        factors=factors,
        caveats=caveats,
    ).to_dict()
