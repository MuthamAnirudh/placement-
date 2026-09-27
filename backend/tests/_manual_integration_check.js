// NOT part of the shipped test suite (no real Postgres available in this sandbox to run
// against) — a throwaway in-memory Prisma mock used once, manually, to sanity-check that
// digitalTwinRepo + knowledgeGraphRepo actually behave correctly end-to-end (upsert
// semantics, idempotent resync, gap-analysis using real mastery data) before trusting them
// against a real database. Safe to delete; kept in the repo only as a documented example of
// how this was verified. Run: node tests/_manual_integration_check.js
const path = require('path');
const assert = require('assert');

// ---- In-memory fake Prisma client -------------------------------------------------------
function makeFakeDb() {
  const skills = new Map(); // id -> {id, name, category}
  const competencies = new Map(); // `${userId}:${skillId}` -> row
  const events = [];
  let idCounter = 0;
  const newId = () => `id${++idCounter}`;

  return {
    skill: {
      findUnique: async ({ where: { name } }) => [...skills.values()].find((s) => s.name === name) || null,
      create: async ({ data }) => {
        const row = { id: newId(), ...data };
        skills.set(row.id, row);
        return row;
      },
      findMany: async ({ where } = {}) => {
        let list = [...skills.values()];
        if (where && where.id && where.id.in) list = list.filter((s) => where.id.in.includes(s.id));
        if (where && where.name && where.name.in) list = list.filter((s) => where.name.in.includes(s.name));
        return list;
      },
    },
    studentCompetency: {
      upsert: async ({ where, update, create }) => {
        const key = `${where.userId_skillId.userId}:${where.userId_skillId.skillId}`;
        const existing = competencies.get(key);
        if (existing) {
          const patch = { ...update };
          if (patch.questionsAnswered && patch.questionsAnswered.increment !== undefined) {
            patch.questionsAnswered = existing.questionsAnswered + patch.questionsAnswered.increment;
          }
          const merged = { ...existing, ...patch };
          competencies.set(key, merged);
          return merged;
        }
        const row = { id: newId(), ...create };
        competencies.set(key, row);
        return row;
      },
      findMany: async ({ where, include }) => {
        const rows = [...competencies.values()].filter((c) => c.userId === where.userId);
        if (include && include.skill) {
          return rows.map((r) => ({ ...r, skill: { name: skills.get(r.skillId).name, category: skills.get(r.skillId).category } }));
        }
        return rows;
      },
    },
    learningEvent: {
      count: async ({ where }) => events.filter((e) => e.userId === where.userId && e.sourceSessionId === where.sourceSessionId).length,
      create: async ({ data }) => {
        const row = { id: newId(), ...data };
        events.push(row);
        return row;
      },
    },
    skillRelation: {
      findMany: async () => globalRelations,
    },
    _debug: { skills, competencies, events },
  };
}

// ---- Inject the fake before requiring anything that pulls in '../db' --------------------
const dbPath = require.resolve('../src/db');
const fakeDb = makeFakeDb();
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const digitalTwinRepo = require('../src/services/digitalTwinRepo');

// Seed a tiny prerequisite chain directly into the fake DB's skill/relation stores, mirroring
// a slice of the real seed data.
let globalRelations = [];
async function seed() {
  const arrays = await fakeDb.skill.create({ data: { name: 'Arrays', category: 'Data Structures' } });
  const linkedLists = await fakeDb.skill.create({ data: { name: 'Linked Lists', category: 'Data Structures' } });
  const trees = await fakeDb.skill.create({ data: { name: 'Trees', category: 'Data Structures' } });
  globalRelations = [
    { fromSkillId: arrays.id, toSkillId: linkedLists.id, type: 'PREREQUISITE_OF' },
    { fromSkillId: linkedLists.id, toSkillId: trees.id, type: 'PREREQUISITE_OF' },
  ];
  return { arrays, linkedLists, trees };
}

async function main() {
  const { arrays, linkedLists, trees } = await seed();
  const userId = 'user1';

  // A finished adaptive_engine report, shaped exactly like build_report()'s real output.
  const report = {
    session_id: 'sess-abc',
    per_topic: [
      { topic: 'Data Structures', level: 'Advanced', theta: 1.1, standard_error: 0.3, p_know: 0.95, mastery_status: 'Mastered', questions_answered: 5, accuracy: 80 },
    ],
    history: [
      { item_id: 'ds1', topic: 'Data Structures', correct: true, theta_after: 0.5, p_know_after: 0.6 },
      { item_id: 'ds2', topic: 'Data Structures', correct: true, theta_after: 1.1, p_know_after: 0.95 },
      { item_id: 'coding:Data Structures', topic: 'Data Structures', correct: true, theta_after: 1.3, p_know_after: 0.97 },
    ],
  };

  // Rename the auto-created "Data Structures" skill to line up with `arrays` etc. being
  // siblings under the same category — actually just resolve it fresh via resolveSkillId
  // inside syncAdaptiveReport itself (it'll auto-create "Data Structures" as its own skill,
  // exactly like it would for a real unseen topic name). That's fine for this check.
  const first = await digitalTwinRepo.syncAdaptiveReport(userId, report);
  assert.strictEqual(first.eventsLogged, 3, 'expected 3 history rows logged as events');
  assert.strictEqual(first.alreadySynced, false);
  console.log('PASS first sync logs 3 events, competency upserted');

  const second = await digitalTwinRepo.syncAdaptiveReport(userId, report);
  assert.strictEqual(second.eventsLogged, 0, 'resync of the same session_id must not double-log events');
  assert.strictEqual(second.alreadySynced, true);
  console.log('PASS resync of identical report is idempotent (no duplicate events)');

  const vector = await digitalTwinRepo.getCompetencyVector(userId);
  assert.strictEqual(vector.competencies.length, 1);
  assert.strictEqual(vector.competencies[0].questionsAnswered, 5, 'questionsAnswered must NOT double-count on resync');
  console.log('PASS competency vector reflects single, non-duplicated count after resync');

  // Now the actual point of the whole exercise: gap-analysis using the user's OWN mastery.
  // The user has p_know=0.95 on "Data Structures" (auto-created top-level skill from the
  // report), but the seeded prerequisite chain is on Arrays -> Linked Lists -> Trees, which
  // this user has NO tracked competency for at all — so every one of them should show up as
  // a gap toward "Trees", proving namesAboveThreshold correctly reads real per-skill data
  // rather than mistaking category-level mastery for sub-skill mastery.
  const gap = await digitalTwinRepo.gapAnalysisForUser(userId, 'Trees', 0.7);
  assert.strictEqual(gap.targetSatisfied, false);
  const missingNames = gap.missingPrerequisites.map((s) => s.name).sort();
  assert.deepStrictEqual(missingNames, ['Arrays', 'Linked Lists']);
  console.log('PASS gap-analysis correctly flags Arrays+Linked Lists as missing for this user (no false mastery bleed from category-level score)');

  console.log('\nALL INTEGRATION CHECKS PASSED');
}

main().catch((err) => {
  console.error('INTEGRATION CHECK FAILED:', err);
  process.exit(1);
});
