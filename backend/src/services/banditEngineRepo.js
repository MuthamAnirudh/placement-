// Thin, DB-touching layer for the bandit recommendation engine — same split as
// digitalTwinRepo.js/knowledgeGraphRepo.js: this file only loads/shapes real rows and hands
// plain data to the pure algorithm in banditEngine.js, so the algorithm itself stays
// unit-testable without a database (see tests/banditEngine.test.js).
const prisma = require('../db');
const bandit = require('./banditEngine');
const graph = require('./knowledgeGraph');
const twin = require('./digitalTwin');

const MASTERY_THRESHOLD = twin.MASTERY_THRESHOLD_FOR_PREREQUISITES; // 0.7, same definition the rest of the Digital Twin uses

// Builds one bandit context vector for a candidate skill. Every value is a real, already-
// computed number — see banditEngine.js's FEATURE_LABELS for what each index means.
function buildContext({ pKnow, questionsAnswered, isWeakCategory, prerequisiteCoverage, categoryAverageMastery }) {
  return [
    1, // bias
    pKnow ?? 0,
    // log-compress lifetime attempt count so a skill practiced 40 times doesn't dominate the
    // feature purely on scale; capped implicitly by the log.
    Math.log(1 + (questionsAnswered ?? 0)) / Math.log(21), // 0 at 0 attempts, 1 at 20 attempts
    isWeakCategory ? 1 : 0,
    prerequisiteCoverage,
    categoryAverageMastery ?? 0,
  ];
}

// Pools every LearningEvent the student has into (context-at-that-skill, reward) training
// pairs. Documented simplification (see banditEngine.js header): we don't store a snapshot
// of the student's full state at each historical event, so every event for a given skill is
// paired with that skill's CURRENT feature profile rather than a reconstructed historical
// one. This is a standard practical approximation for slow-changing features (prerequisite
// structure and category rarely change) and is called out explicitly in the response's
// `method` field rather than presented as a perfect sequential reconstruction.
function buildTrainingExamples(events, contextBySkillId) {
  const examples = [];
  for (const ev of events) {
    if (ev.pKnowAfter === null || ev.pKnowAfter === undefined) continue; // no usable reward
    const context = contextBySkillId.get(ev.skillId);
    if (!context) continue; // skill fell out of the candidate set (e.g. already mastered now)
    examples.push({ context, reward: Math.max(0, Math.min(1, ev.pKnowAfter)) });
  }
  return examples;
}

async function recommendNextSkill(userId, { alpha = 1.0, maxCandidates = 40 } = {}) {
  const [competencyRows, allSkills, relations, events] = await Promise.all([
    prisma.studentCompetency.findMany({ where: { userId }, include: { skill: true } }),
    prisma.skill.findMany(),
    prisma.skillRelation.findMany({ select: { id: true, fromSkillId: true, toSkillId: true, type: true, weight: true } }),
    prisma.learningEvent.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
  ]);

  if (allSkills.length === 0) {
    return { recommendation: null, ranked: [], method: 'no-skills-in-graph', coldStart: false };
  }

  const competencyBySkillId = new Map(competencyRows.map((c) => [c.skillId, c]));
  const masteredIds = new Set(
    competencyRows.filter((c) => (c.pKnow ?? 0) >= MASTERY_THRESHOLD).map((c) => c.skillId)
  );

  // Per-category average mastery — a real rollup, reused from digitalTwin.js's own logic so
  // this stays consistent with what the Dashboard already shows.
  const competencies = competencyRows.map((c) => ({
    skillId: c.skillId, skillName: c.skill.name, category: c.skill.category, pKnow: c.pKnow,
  }));
  const categoryRollup = twin.byCategoryRollup(competencies);
  const categoryAvgByName = new Map(categoryRollup.map((c) => [c.category, c.averageMastery]));
  const weakestCategories = new Set(
    categoryRollup.filter((c) => c.averageMastery !== null).slice(0, 2).map((c) => c.category)
  );

  // Candidate set: every skill NOT yet mastered whose prerequisites (if any) are ALL
  // satisfied — i.e. the real "frontier" of what the graph says is learnable right now,
  // computed with the exact same gapAnalysis-style traversal the Dashboard's Knowledge-Graph
  // panel uses (knowledgeGraph.js, unit-tested in tests/knowledgeGraph.test.js).
  const candidates = [];
  const contextBySkillId = new Map();
  // Pass 1: build a context for EVERY skill, mastered or not. A mastered skill's own past
  // LearningEvents are still legitimate training signal for the shared model (its feature
  // profile — category, prerequisite depth — still informs what "a rewarding skill to
  // practice" looks like) even though the skill itself won't be offered as a candidate
  // below. Skipping context-building for mastered skills would silently discard exactly the
  // reward history most likely to exist (the skills the student has practiced enough to
  // master), which is the bug this comment is here to prevent regressing.
  for (const skill of allSkills) {
    const prereqIds = graph.transitivePrerequisites(skill.id, relations);
    const missingPrereqs = prereqIds.filter((id) => !masteredIds.has(id));
    const prerequisiteCoverage = prereqIds.length === 0 ? 1.0 : 1 - missingPrereqs.length / prereqIds.length;
    const comp = competencyBySkillId.get(skill.id);
    const context = buildContext({
      pKnow: comp ? comp.pKnow : null,
      questionsAnswered: comp ? comp.questionsAnswered : 0,
      isWeakCategory: weakestCategories.has(skill.category),
      prerequisiteCoverage,
      categoryAverageMastery: categoryAvgByName.get(skill.category) ?? 0,
    });
    contextBySkillId.set(skill.id, context);

    // Only unblocked, not-yet-mastered skills are real "practice this next" candidates —
    // recommending something already mastered, or something the student can't attempt yet
    // (missing prerequisites), wouldn't be actionable, so both are excluded from the arm set
    // entirely rather than scored low.
    if (!masteredIds.has(skill.id) && missingPrereqs.length === 0) {
      candidates.push({
        id: skill.id,
        label: skill.name,
        context,
        meta: {
          category: skill.category,
          currentMastery: comp ? comp.pKnow : null,
          masteryStatus: comp ? comp.masteryStatus : 'Not Started',
          questionsAnswered: comp ? comp.questionsAnswered : 0,
          prerequisiteCoverage,
          isWeakCategory: weakestCategories.has(skill.category),
        },
      });
    }
  }

  const trimmedCandidates = candidates.slice(0, maxCandidates);
  const trainingExamples = buildTrainingExamples(events, contextBySkillId);
  const result = bandit.selectNextSkill(trimmedCandidates, trainingExamples, { alpha });

  return {
    ...result,
    candidateCount: trimmedCandidates.length,
    totalSkillsInGraph: allSkills.length,
    totalLearningEventsUsed: trainingExamples.length,
  };
}

module.exports = { recommendNextSkill, buildContext, buildTrainingExamples };
