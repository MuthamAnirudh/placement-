// Pure functions over a plain competency list — no Prisma/DB dependency, same philosophy as
// knowledgeGraph.js: keep the actual logic unit-testable, keep the Prisma-touching code in
// digitalTwinRepo.js thin. Shape: competency = { skillId, skillName, category, theta,
// standardError, level, pKnow, masteryStatus, questionsAnswered, lastPracticedAt }.

// A skill counts as "known enough" to satisfy a prerequisite for gap-analysis purposes once
// BKT crosses this threshold — deliberately NOT the same as the 0.95 "Mastered" cutoff used
// for display. Requiring full 0.95 mastery on every single prerequisite before letting a
// roadmap consider the next skill "unblocked" would be pedagogically too strict (real
// curricula don't wait for 95% confidence in Arrays before touching Linked Lists); 0.7
// ("Approaching Mastery" per adaptive_engine._mastery_status) is the documented, adjustable
// design choice here.
const MASTERY_THRESHOLD_FOR_PREREQUISITES = 0.7;

// Provisional pKnow assigned to a skill when the ONLY evidence for it is a resume listing
// matched against a job description (digitalTwinRepo.syncResumeMatch) — self-reported, never
// tested. Deliberately the same 0.6 "listed but unverified" convention already used by
// ai-ml-service's career_path.py mastery_bonus default, so a skill reads the same whether the
// unverified-assumption came from the career-path scorer or from a resume sync, instead of
// inventing a second number for the same concept. Lands in the 'Developing' masteryStatus
// bucket (see masteryStatusForPKnow) — never 'Mastered' or 'Approaching Mastery' — precisely
// because it hasn't been tested.
const RESUME_EVIDENCE_PKNOW = 0.6;

function namesAboveThreshold(competencies, threshold = MASTERY_THRESHOLD_FOR_PREREQUISITES) {
  return competencies.filter((c) => (c.pKnow ?? 0) >= threshold).map((c) => c.skillName);
}

function overallMastery(competencies) {
  const withData = competencies.filter((c) => c.pKnow !== null && c.pKnow !== undefined);
  if (withData.length === 0) return null;
  return withData.reduce((sum, c) => sum + c.pKnow, 0) / withData.length;
}

function weakestSkills(competencies, n = 3) {
  return competencies
    .filter((c) => c.pKnow !== null && c.pKnow !== undefined)
    .slice()
    .sort((a, b) => a.pKnow - b.pKnow)
    .slice(0, n);
}

function strongestSkills(competencies, n = 3) {
  return competencies
    .filter((c) => c.pKnow !== null && c.pKnow !== undefined)
    .slice()
    .sort((a, b) => b.pKnow - a.pKnow)
    .slice(0, n);
}

// Rolls per-skill competencies up to per-category (= per adaptive-engine topic) averages,
// for a dashboard summary view without the caller re-deriving it from the raw list.
function byCategoryRollup(competencies) {
  const groups = new Map();
  for (const c of competencies) {
    const key = c.category || 'Uncategorized';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const rollup = [];
  for (const [category, items] of groups) {
    const mastery = overallMastery(items);
    rollup.push({
      category,
      skillCount: items.length,
      averageMastery: mastery,
      skillsTracked: items.filter((c) => c.pKnow !== null && c.pKnow !== undefined).length,
    });
  }
  return rollup.sort((a, b) => (a.averageMastery ?? 1) - (b.averageMastery ?? 1));
}

module.exports = {
  MASTERY_THRESHOLD_FOR_PREREQUISITES,
  RESUME_EVIDENCE_PKNOW,
  namesAboveThreshold,
  overallMastery,
  weakestSkills,
  strongestSkills,
  byCategoryRollup,
};
