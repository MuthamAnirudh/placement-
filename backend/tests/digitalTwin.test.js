// Plain-Node test runner, same pattern as tests/knowledgeGraph.test.js.
// Run with: node tests/digitalTwin.test.js
const assert = require('assert');
const {
  namesAboveThreshold, overallMastery, weakestSkills, strongestSkills, byCategoryRollup,
} = require('../src/services/digitalTwin');

const competencies = [
  { skillId: '1', skillName: 'Data Structures', category: 'Data Structures', pKnow: 0.97 },
  { skillId: '2', skillName: 'Algorithms', category: 'Algorithms', pKnow: 0.55 },
  { skillId: '3', skillName: 'SQL', category: 'SQL', pKnow: 0.12 },
  { skillId: '4', skillName: 'Python', category: 'Python', pKnow: null }, // never practiced
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

test('namesAboveThreshold excludes below-threshold and untracked skills', () => {
  const names = namesAboveThreshold(competencies, 0.7);
  assert.deepStrictEqual(names, ['Data Structures']);
});

test('overallMastery ignores null/untracked entries', () => {
  const avg = overallMastery(competencies);
  assert.strictEqual(Math.round(avg * 1000) / 1000, Math.round(((0.97 + 0.55 + 0.12) / 3) * 1000) / 1000);
});

test('overallMastery returns null when nothing has been practiced', () => {
  assert.strictEqual(overallMastery([{ skillId: 'x', pKnow: null }]), null);
});

test('weakestSkills sorts ascending and excludes untracked', () => {
  const weak = weakestSkills(competencies, 2);
  assert.deepStrictEqual(weak.map((c) => c.skillName), ['SQL', 'Algorithms']);
});

test('strongestSkills sorts descending', () => {
  const strong = strongestSkills(competencies, 1);
  assert.deepStrictEqual(strong.map((c) => c.skillName), ['Data Structures']);
});

test('byCategoryRollup groups and sorts weakest-category-first, untracked categories last', () => {
  const rollup = byCategoryRollup(competencies);
  assert.strictEqual(rollup[0].category, 'SQL'); // 0.12 — genuinely weakest, should lead
  // Python has never been practiced (averageMastery=null) — treated as "unknown", not
  // "weak", so it should NOT be flagged ahead of a real low score; it sorts to the very end,
  // after even the highest real score (Data Structures, 0.97).
  assert.strictEqual(rollup[rollup.length - 1].category, 'Python');
  assert.strictEqual(rollup[rollup.length - 2].category, 'Data Structures');
  const python = rollup.find((r) => r.category === 'Python');
  assert.strictEqual(python.skillsTracked, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
