// NOT part of the shipped test suite (no real Postgres available in this sandbox) — a
// throwaway in-memory Prisma mock used once, manually, to sanity-check that
// banditEngineRepo.recommendNextSkill behaves correctly end-to-end (candidate filtering by
// prerequisite/mastery, cold-start fallback, and that real reward history actually shifts
// the recommendation) before trusting it against a real database.
// Run: node tests/_manual_integration_check_bandit.js
const assert = require('assert');
const path = require('path');

function makeFakeDb({ skills, relations, competencies, events }) {
  return {
    skill: { findMany: async () => skills },
    skillRelation: { findMany: async () => relations },
    studentCompetency: {
      findMany: async ({ where, include }) => {
        const rows = competencies.filter((c) => c.userId === where.userId);
        if (include && include.skill) {
          return rows.map((r) => ({ ...r, skill: skills.find((s) => s.id === r.skillId) }));
        }
        return rows;
      },
    },
    learningEvent: {
      findMany: async ({ where }) => events.filter((e) => e.userId === where.userId),
    },
  };
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (err) { console.log(`FAIL ${name}: ${err.stack}`); failed++; }
}

async function run() {
  // --- Fixture: Arrays -> LinkedLists -> Trees, plus an unrelated already-mastered skill ---
  const skills = [
    { id: 's-arrays', name: 'Arrays', category: 'DSA' },
    { id: 's-linkedlists', name: 'Linked Lists', category: 'DSA' },
    { id: 's-trees', name: 'Trees', category: 'DSA' },
    { id: 's-sql', name: 'SQL', category: 'Databases' },
  ];
  const relations = [
    { id: 'r1', fromSkillId: 's-arrays', toSkillId: 's-linkedlists', type: 'PREREQUISITE_OF', weight: 1 },
    { id: 'r2', fromSkillId: 's-linkedlists', toSkillId: 's-trees', type: 'PREREQUISITE_OF', weight: 1 },
  ];

  await (async () => {
    // Scenario 1: brand-new student, nothing mastered, no events -> cold start, and Trees
    // (blocked by two prerequisites) must NOT appear as a candidate at all.
    delete require.cache[require.resolve('../src/db')];
    require.cache[require.resolve('../src/db')] = {
      id: require.resolve('../src/db'),
      filename: require.resolve('../src/db'),
      loaded: true,
      exports: makeFakeDb({ skills, relations, competencies: [], events: [] }),
    };
    delete require.cache[require.resolve('../src/services/banditEngineRepo')];
    const repo = require('../src/services/banditEngineRepo');

    const result = await repo.recommendNextSkill('user-1');
    test('brand-new student: cold-start method used', () => {
      assert.strictEqual(result.coldStart, true);
    });
    test('brand-new student: Trees excluded (blocked by 2 unmet prerequisites)', () => {
      assert.ok(!result.ranked.some((r) => r.id === 's-trees'));
    });
    test('brand-new student: Arrays and SQL both candidates (zero prerequisites each)', () => {
      const ids = result.ranked.map((r) => r.id);
      assert.ok(ids.includes('s-arrays') && ids.includes('s-sql'));
    });
  })();

  await (async () => {
    // Scenario 2: student has mastered Arrays (pKnow 0.9) -> Linked Lists should now be
    // unblocked and become a real candidate; Trees still blocked (Linked Lists not mastered).
    const competencies = [
      { userId: 'user-2', skillId: 's-arrays', pKnow: 0.9, questionsAnswered: 12, masteryStatus: 'Mastered' },
    ];
    const events = [
      { userId: 'user-2', skillId: 's-arrays', pKnowAfter: 0.9, createdAt: new Date() },
    ];
    require.cache[require.resolve('../src/db')].exports = makeFakeDb({ skills, relations, competencies, events });
    delete require.cache[require.resolve('../src/services/banditEngineRepo')];
    const repo = require('../src/services/banditEngineRepo');

    const result = await repo.recommendNextSkill('user-2');
    test('after mastering Arrays: Linked Lists becomes a candidate', () => {
      assert.ok(result.ranked.some((r) => r.id === 's-linkedlists'));
    });
    test('after mastering Arrays: Trees is still blocked (Linked Lists not yet mastered)', () => {
      assert.ok(!result.ranked.some((r) => r.id === 's-trees'));
    });
    test('after mastering Arrays: Arrays itself is excluded (already mastered)', () => {
      assert.ok(!result.ranked.some((r) => r.id === 's-arrays'));
    });
    test('with one real LearningEvent, model is trained (not cold-start)', () => {
      assert.strictEqual(result.coldStart, false);
      assert.strictEqual(result.totalLearningEventsUsed, 1);
    });
  })();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
