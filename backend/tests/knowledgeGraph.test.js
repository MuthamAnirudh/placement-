// Plain-Node test runner (no framework installed in this project yet — see README for
// adding Jest/Vitest later). Run with: node tests/knowledgeGraph.test.js
const assert = require('assert');
const {
  transitivePrerequisites,
  wouldCreateCycle,
  topologicalOrder,
  gapAnalysis,
  directNeighbors,
} = require('../src/services/knowledgeGraph');

// Small fixture graph mirroring the doc's own example:
// Arrays -> Linked Lists -> Trees -> Graphs -> Dynamic Programming
const skills = {
  arrays: 'arrays', linkedLists: 'linkedLists', stacks: 'stacks', queues: 'queues',
  trees: 'trees', graphs: 'graphs', dp: 'dp',
};
const relations = [
  { fromSkillId: skills.arrays, toSkillId: skills.linkedLists, type: 'PREREQUISITE_OF' },
  { fromSkillId: skills.linkedLists, toSkillId: skills.stacks, type: 'PREREQUISITE_OF' },
  { fromSkillId: skills.linkedLists, toSkillId: skills.queues, type: 'PREREQUISITE_OF' },
  { fromSkillId: skills.linkedLists, toSkillId: skills.trees, type: 'PREREQUISITE_OF' },
  { fromSkillId: skills.trees, toSkillId: skills.graphs, type: 'PREREQUISITE_OF' },
  { fromSkillId: skills.stacks, toSkillId: skills.graphs, type: 'PREREQUISITE_OF' },
  { fromSkillId: skills.queues, toSkillId: skills.graphs, type: 'PREREQUISITE_OF' },
  { fromSkillId: skills.graphs, toSkillId: skills.dp, type: 'PREREQUISITE_OF' },
  { fromSkillId: skills.stacks, toSkillId: skills.queues, type: 'COMMONLY_CONFUSED_WITH' },
];

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

test('transitivePrerequisites finds all ancestors, not just direct ones', () => {
  const prereqs = transitivePrerequisites(skills.dp, relations);
  // Everything upstream of DP: graphs, trees, stacks, queues, linkedLists, arrays
  const expected = [skills.graphs, skills.trees, skills.stacks, skills.queues, skills.linkedLists, skills.arrays];
  for (const e of expected) assert(prereqs.includes(e), `expected ${e} in prereqs of dp`);
  assert.strictEqual(prereqs.length, expected.length);
});

test('transitivePrerequisites of a root skill is empty', () => {
  assert.deepStrictEqual(transitivePrerequisites(skills.arrays, relations), []);
});

test('topologicalOrder respects all prerequisite edges', () => {
  const order = topologicalOrder(Object.values(skills), relations);
  const pos = (id) => order.indexOf(id);
  for (const r of relations) {
    if (r.type !== 'PREREQUISITE_OF') continue;
    assert(pos(r.fromSkillId) < pos(r.toSkillId), `${r.fromSkillId} should come before ${r.toSkillId}`);
  }
});

test('wouldCreateCycle detects a direct back-edge', () => {
  // dp -> arrays would close the loop back to the root.
  assert.strictEqual(wouldCreateCycle(skills.dp, skills.arrays, relations, 'PREREQUISITE_OF'), true);
});

test('wouldCreateCycle allows a legitimate new forward edge', () => {
  // A brand-new skill with no existing edges can't create a cycle.
  assert.strictEqual(wouldCreateCycle('newSkill', skills.dp, relations, 'PREREQUISITE_OF'), false);
});

test('wouldCreateCycle rejects a self-loop', () => {
  assert.strictEqual(wouldCreateCycle(skills.arrays, skills.arrays, relations, 'PREREQUISITE_OF'), true);
});

test('gapAnalysis: student who knows nothing needs the full chain to reach dp', () => {
  const result = gapAnalysis(skills.dp, [], relations);
  assert.strictEqual(result.targetSatisfied, false);
  assert(result.missingPrerequisiteIds.includes(skills.arrays));
  assert(result.missingPrerequisiteIds.includes(skills.graphs));
  // Learn order must end with dp itself and respect prerequisite order.
  assert.strictEqual(result.learnOrderIds[result.learnOrderIds.length - 1], skills.dp);
  assert(result.learnOrderIds.indexOf(skills.arrays) < result.learnOrderIds.indexOf(skills.linkedLists));
});

test('gapAnalysis: student who already knows everything upstream has zero gaps', () => {
  const mastered = [skills.arrays, skills.linkedLists, skills.stacks, skills.queues, skills.trees, skills.graphs];
  const result = gapAnalysis(skills.dp, mastered, relations);
  assert.strictEqual(result.missingPrerequisiteIds.length, 0);
  assert.deepStrictEqual(result.learnOrderIds, [skills.dp]);
});

test('gapAnalysis: target already mastered means targetSatisfied=true and nothing to learn', () => {
  const mastered = [skills.arrays, skills.linkedLists, skills.stacks, skills.queues, skills.trees, skills.graphs, skills.dp];
  const result = gapAnalysis(skills.dp, mastered, relations);
  assert.strictEqual(result.targetSatisfied, true);
  assert.strictEqual(result.learnOrderIds.length, 0);
});

test('directNeighbors finds COMMONLY_CONFUSED_WITH in both directions', () => {
  assert.deepStrictEqual(directNeighbors(skills.stacks, relations, 'COMMONLY_CONFUSED_WITH'), [skills.queues]);
  assert.deepStrictEqual(directNeighbors(skills.queues, relations, 'COMMONLY_CONFUSED_WITH'), [skills.stacks]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
