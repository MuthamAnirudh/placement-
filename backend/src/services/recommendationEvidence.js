// Mirrors the Evidence/Factor shape defined in ai-ml-service/app/services/explainability.py
// so the frontend's single WhyThisRecommendation component can render either service's
// output with no special-casing. Same honesty rule applies: every number here is read
// straight off the bandit's own real computation (banditEngine.js), never approximated or
// invented for display purposes.
function buildNextSkillEvidence(banditResult) {
  const { recommendation, coldStart, method, trainingExampleCount, alpha } = banditResult;
  if (!recommendation) return null;

  if (coldStart) {
    return {
      recommendation: `Practice ${recommendation.label} next.`,
      confidence: null,
      method: 'No graded attempts logged yet for this account, so the contextual bandit has no reward '
        + 'history to fit against — ranking falls back to prerequisite coverage only (skills with no '
        + 'unmet prerequisites first).',
      factors: [{
        label: 'Prerequisite coverage',
        detail: `${Math.round((recommendation.meta?.prerequisiteCoverage ?? 1) * 100)}% of this skill's `
          + 'prerequisites are already satisfied — it is fully unblocked in the Knowledge Graph.',
        contribution_pct: Math.round((recommendation.meta?.prerequisiteCoverage ?? 1) * 100),
        direction: 'supports',
      }],
      caveats: ['This will switch to a trained reward-based ranking once you have completed at least one Adaptive Diagnostic.'],
    };
  }

  const { pointEstimate, uncertainty, ucbScore, meta } = recommendation;
  const exploitationShare = ucbScore ? Math.round(100 * (pointEstimate / ucbScore)) : null;
  const explorationShare = ucbScore ? 100 - exploitationShare : null;

  const factors = [
    {
      label: 'Predicted mastery gain (exploitation)',
      detail: `Based on ${trainingExampleCount} of your own past graded attempts, skills with a similar `
        + `feature profile (category, prerequisite depth, current mastery) tend to resolve around `
        + `${Math.round(pointEstimate * 100)}/100 mastery.`,
      contribution_pct: Math.round(pointEstimate * 100),
      direction: pointEstimate >= 0 ? 'supports' : 'against',
    },
    {
      label: 'Exploration bonus (uncertainty)',
      detail: (meta?.questionsAnswered ?? 0) === 0
        ? "You haven't attempted this exact skill yet — the bandit weights unexplored skills higher so it "
          + 'keeps sampling the whole graph rather than only ever recommending the same well-known skill.'
        : `You've attempted this skill ${meta.questionsAnswered} time(s) before, so its uncertainty bonus is `
          + 'smaller than for a completely untried skill.',
      contribution_pct: Math.round((alpha ?? 1) * uncertainty * 100) / 100,
      direction: 'neutral',
    },
    {
      label: 'Prerequisite coverage',
      detail: `${Math.round((meta?.prerequisiteCoverage ?? 1) * 100)}% of prerequisites already satisfied — `
        + 'this skill is actionable right now, not just theoretically relevant.',
      contribution_pct: Math.round((meta?.prerequisiteCoverage ?? 1) * 100),
      direction: 'supports',
    },
  ];
  if (meta?.isWeakCategory) {
    factors.push({
      label: 'Weak category',
      detail: `${meta.category} is one of your two lowest-scoring categories right now.`,
      contribution_pct: 0,
      direction: 'supports',
    });
  }

  return {
    recommendation: `Practice ${recommendation.label} next.`,
    confidence: Math.round(pointEstimate * 100),
    method: `LinUCB contextual bandit (shared linear model across candidate skills) fit on ${trainingExampleCount} `
      + `real graded attempts from your Adaptive Diagnostic history. Score = predicted mastery gain `
      + `(${exploitationShare}% of the ranking) + an exploration bonus for under-tried skills `
      + `(${explorationShare}%). No LLM is used for this ranking. `
      + 'Scope note: only ranks the "which skill to practice" decision — video/interview/project actions '
      + "aren't reward-instrumented yet, so they're not part of this arm set.",
    factors,
    caveats: [
      'This is a bandit over "which skill to practice next," not a guarantee you will master it in one '
        + 'session — mastery gain is an average tendency from your own history, not a per-attempt promise.',
    ],
  };
}

module.exports = { buildNextSkillEvidence };
