// Contextual bandit ("sequential decision engine") for the Student Digital Twin.
//
// SCOPE — read before extending: the project spec's Reinforcement-Learning section asks for
// a policy over actions = {video, quiz, coding problem, revision, interview, project,
// practice exercise}, rewarded by "measured improvement in competency". Today only ONE of
// those actions actually produces a measurable, logged reward: attempting a skill via the
// Adaptive Diagnostic (MCQ/coding), which writes a LearningEvent row with a real pKnowAfter
// value (backend/prisma/schema.prisma). Video-tutor views, roadmap steps, and mock
// interviews are not yet reward-instrumented. Per spec rule #33/#15 ("if a full
// implementation isn't justified, implement a contextual bandit and document the
// limitation"), this engine is deliberately scoped to the one decision that has real reward
// data behind it: WHICH NOT-YET-MASTERED, PREREQUISITE-SATISFIED SKILL TO PRACTICE NEXT.
// Extending it to the full action set means adding reward-logging to those other flows
// first (each would get its own `type` value alongside ADAPTIVE_MCQ/ADAPTIVE_CODING in the
// LearningEventType enum) — the algorithm below does not need to change to support that.
//
// ALGORITHM — LinUCB (Li et al., 2010) with a single SHARED linear model across arms rather
// than one model per arm. This is a deliberate, documented choice: disjoint per-arm LinUCB
// needs enough history PER ARM to fit a d-dimensional model, but a single student's history
// is small and spread across many skills, so almost every arm would be stuck in permanent
// cold-start. Sharing one model across arms and letting the ARM'S OWN FEATURES (not a
// per-arm identity) carry the signal is the standard fix for exactly this small-N regime,
// and is mathematically still a linear contextual bandit: A and b are accumulated once,
// pooled over every (context, reward) pair regardless of which arm produced it.
//
// Every number this module touches is either (a) a real StudentCompetency/LearningEvent
// value passed in by the caller (banditEngineRepo.js), or (b) arithmetic performed on those
// values. Nothing here is randomly generated or hardcoded as a placeholder.

const FEATURE_LABELS = [
  'bias',
  'currentMastery',
  'practiceVolume',
  'isWeakCategory',
  'prerequisiteCoverage',
  'categoryAverageMastery',
];
const DIMS = FEATURE_LABELS.length;

function zeros(n) {
  return new Array(n).fill(0);
}

function identity(n, scale = 1) {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? scale : 0)));
}

function matAdd(a, b) {
  return a.map((row, i) => row.map((v, j) => v + b[i][j]));
}

function outerProduct(x) {
  return x.map((xi) => x.map((xj) => xi * xj));
}

function matVec(mat, vec) {
  return mat.map((row) => row.reduce((s, v, j) => s + v * vec[j], 0));
}

function dot(a, b) {
  return a.reduce((s, v, i) => s + v * b[i], 0);
}

function scaleVec(vec, s) {
  return vec.map((v) => v * s);
}

function vecAdd(a, b) {
  return a.map((v, i) => v + b[i]);
}

// Gauss-Jordan matrix inversion. DIMS is fixed and small (6), so this is always cheap and
// never needs a numerical library.
function matInverse(mat) {
  const n = mat.length;
  const aug = mat.map((row, i) => [...row, ...identity(n)[i]]);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[pivotRow][col])) pivotRow = r;
    }
    [aug[col], aug[pivotRow]] = [aug[pivotRow], aug[col]];
    let pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-10) {
      // Singular (shouldn't happen — A starts as lambda*I with lambda > 0 and only ever
      // gains positive-semidefinite outer products) — fall back to a tiny ridge bump.
      aug[col][col] += 1e-6;
      pivot = aug[col][col];
    }
    // Divide by the CAPTURED pivot value, not the live aug[col][col] cell — that cell is
    // itself one of the entries being divided in this same loop (when k === col), so
    // reading it live would silently divide the remaining entries by 1 instead of by pivot.
    for (let k = 0; k < 2 * n; k++) aug[col][k] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = aug[r][col];
      for (let k = 0; k < 2 * n; k++) aug[r][k] -= factor * aug[col][k];
    }
  }
  return aug.map((row) => row.slice(n));
}

// trainingExamples: [{ context: number[DIMS], reward: number (0-1) }, ...]
// Returns the fitted { A, b, Ainv } for scoreArm() below. lambda is the ridge-regularization
// strength (keeps A invertible even with zero/one training examples).
function fitLinUCB(trainingExamples, lambda = 1.0) {
  let A = identity(DIMS, lambda);
  let b = zeros(DIMS);
  for (const ex of trainingExamples) {
    A = matAdd(A, outerProduct(ex.context));
    b = vecAdd(b, scaleVec(ex.context, ex.reward));
  }
  const Ainv = matInverse(A);
  return { A, b, Ainv };
}

// UCB score for one candidate arm's context: exploitation term (predicted reward under the
// fitted model) + alpha * exploration term (uncertainty — how little this region of feature
// space has been observed). alpha controls the explore/exploit tradeoff explicitly, rather
// than hiding it.
function scoreArm(context, { Ainv, b }, alpha) {
  const theta = matVec(Ainv, b);
  const pointEstimate = dot(theta, context);
  const uncertainty = Math.sqrt(Math.max(0, dot(context, matVec(Ainv, context))));
  return {
    pointEstimate,
    uncertainty,
    ucbScore: pointEstimate + alpha * uncertainty,
  };
}

// arms: [{ id, label, context: number[DIMS], meta: {...} }, ...]
// trainingExamples: pooled (context, reward) pairs from the student's real LearningEvent
// history (see banditEngineRepo.buildTrainingExamples).
function selectNextSkill(arms, trainingExamples, { alpha = 1.0 } = {}) {
  if (!arms.length) {
    return { recommendation: null, ranked: [], method: 'no-candidates', coldStart: false };
  }
  if (trainingExamples.length === 0) {
    // Honest cold-start fallback: with zero reward history, a fitted linear model has
    // nothing to fit — rather than show a fabricated confidence number, rank candidates by
    // prerequisite coverage only (a real, already-computed graph fact: "most unblocked
    // first") and say so explicitly.
    const ranked = arms
      .slice()
      .sort((a, b) => b.context[4] - a.context[4]) // index 4 = prerequisiteCoverage
      .map((a) => ({ ...a, pointEstimate: null, uncertainty: null, ucbScore: null }));
    return {
      recommendation: ranked[0],
      ranked,
      method: 'cold-start-heuristic',
      coldStart: true,
    };
  }
  const model = fitLinUCB(trainingExamples);
  const ranked = arms
    .map((a) => ({ ...a, ...scoreArm(a.context, model, alpha) }))
    .sort((a, b) => b.ucbScore - a.ucbScore);
  return {
    recommendation: ranked[0],
    ranked,
    method: 'linucb-shared-model',
    coldStart: false,
    trainingExampleCount: trainingExamples.length,
    alpha,
  };
}

module.exports = {
  FEATURE_LABELS,
  DIMS,
  matAdd,
  outerProduct,
  matVec,
  matInverse,
  identity,
  fitLinUCB,
  scoreArm,
  selectNextSkill,
};
