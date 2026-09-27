// Run with: node tests/banditEngine.test.js
const assert = require('assert');
const {
  DIMS, matInverse, identity, matAdd, outerProduct, fitLinUCB, scoreArm, selectNextSkill,
} = require('../src/services/banditEngine');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL ${name}: ${err.message}`);
    failed++;
  }
}

function approxEqual(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

test('matInverse inverts the identity matrix to itself', () => {
  const I = identity(3);
  const inv = matInverse(I);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    assert.ok(approxEqual(inv[i][j], I[i][j]), `mismatch at [${i}][${j}]`);
  }
});

test('matInverse correctly inverts a known 2x2 matrix', () => {
  // [[4,7],[2,6]] -> inverse is 1/10 * [[6,-7],[-2,4]]
  const m = [[4, 7], [2, 6]];
  const inv = matInverse(m);
  assert.ok(approxEqual(inv[0][0], 0.6));
  assert.ok(approxEqual(inv[0][1], -0.7));
  assert.ok(approxEqual(inv[1][0], -0.2));
  assert.ok(approxEqual(inv[1][1], 0.4));
});

test('A * A_inverse is (approximately) the identity matrix', () => {
  const A = matAdd(identity(DIMS, 1.0), outerProduct([1, 0.5, 0.2, 1, 0.8, 0.4]));
  const Ainv = matInverse(A);
  // Multiply A by its inverse and check we get back ~I
  for (let i = 0; i < DIMS; i++) {
    for (let j = 0; j < DIMS; j++) {
      let sum = 0;
      for (let k = 0; k < DIMS; k++) sum += A[i][k] * Ainv[k][j];
      const expected = i === j ? 1 : 0;
      assert.ok(approxEqual(sum, expected, 1e-4), `A*Ainv[${i}][${j}] = ${sum}, expected ${expected}`);
    }
  }
});

test('selectNextSkill falls back to cold-start heuristic with zero training examples', () => {
  const arms = [
    { id: 'a', label: 'Arrays', context: [1, 0, 0, 0, 1.0, 0] },   // fully unblocked
    { id: 'b', label: 'Graphs', context: [1, 0, 0, 0, 0.2, 0] },   // mostly blocked
  ];
  const result = selectNextSkill(arms, []);
  assert.strictEqual(result.coldStart, true);
  assert.strictEqual(result.method, 'cold-start-heuristic');
  assert.strictEqual(result.recommendation.id, 'a'); // higher prerequisiteCoverage wins
});

test('selectNextSkill returns null recommendation for an empty arm list', () => {
  const result = selectNextSkill([], []);
  assert.strictEqual(result.recommendation, null);
  assert.deepStrictEqual(result.ranked, []);
});

test('fitLinUCB + scoreArm: a feature that consistently earns high reward gets a higher point estimate', () => {
  // Two "kinds" of skill: one whose practice history always rewarded well (index 1 = 1),
  // one that never did (index 1 = 0). After fitting, an unseen arm that looks like the
  // high-reward kind should score higher than one that looks like the low-reward kind.
  const trainingExamples = [];
  for (let i = 0; i < 20; i++) {
    trainingExamples.push({ context: [1, 1, 0, 0, 1, 0.9], reward: 0.9 });
    trainingExamples.push({ context: [1, 0, 0, 0, 1, 0.1], reward: 0.1 });
  }
  const model = fitLinUCB(trainingExamples, 1.0);
  const highLike = scoreArm([1, 1, 0, 0, 1, 0.9], model, 0); // alpha=0 -> pure exploitation
  const lowLike = scoreArm([1, 0, 0, 0, 1, 0.1], model, 0);
  assert.ok(highLike.pointEstimate > lowLike.pointEstimate,
    `expected high-reward-like arm to score higher: ${highLike.pointEstimate} vs ${lowLike.pointEstimate}`);
});

test('scoreArm uncertainty is higher for a context far from the training data', () => {
  const trainingExamples = [{ context: [1, 0.5, 0.5, 0, 1, 0.5], reward: 0.5 }];
  const model = fitLinUCB(trainingExamples, 1.0);
  const near = scoreArm([1, 0.5, 0.5, 0, 1, 0.5], model, 1.0);
  const far = scoreArm([1, -3, -3, 1, 0, -3], model, 1.0);
  assert.ok(far.uncertainty > near.uncertainty,
    `expected far context to have higher uncertainty: ${far.uncertainty} vs ${near.uncertainty}`);
});

test('selectNextSkill ranks by UCB score (exploitation + exploration) once trained', () => {
  const trainingExamples = [];
  for (let i = 0; i < 10; i++) trainingExamples.push({ context: [1, 1, 1, 0, 1, 0.9], reward: 0.9 });
  const arms = [
    { id: 'strong-match', label: 'Recursion', context: [1, 1, 1, 0, 1, 0.9] },
    { id: 'weak-match', label: 'Assembly', context: [1, 0, 0, 1, 0.2, 0.1] },
  ];
  const result = selectNextSkill(arms, trainingExamples, { alpha: 0.1 });
  assert.strictEqual(result.coldStart, false);
  assert.strictEqual(result.method, 'linucb-shared-model');
  assert.strictEqual(result.recommendation.id, 'strong-match');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
