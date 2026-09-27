const prisma = require('../db');
const twin = require('./digitalTwin');
const { RESUME_EVIDENCE_PKNOW } = twin;
const graphRepo = require('./knowledgeGraphRepo');

async function resolveSkillId(name, cache) {
  if (cache.has(name)) return cache.get(name);
  let skill = await prisma.skill.findUnique({ where: { name } });
  if (!skill) {
    // A topic reported by the adaptive engine that isn't yet a graph node (e.g. a newly
    // added question-bank topic the seed hasn't caught up with) — auto-create it as its own
    // top-level skill rather than dropping the data on the floor. Admins can enrich it with
    // real prerequisite edges later via POST /api/graph/relations; this just guarantees sync
    // never silently loses a topic.
    skill = await prisma.skill.create({ data: { name, category: name } });
  }
  cache.set(name, skill.id);
  return skill.id;
}

// Ingests one adaptive_engine.build_report() JSON payload for a user: upserts the
// current-state StudentCompetency row per topic, and — the first time a given session_id is
// seen — appends one LearningEvent per graded response from report.history. Safe to call
// more than once with the same report (e.g. a flaky network retry): competency rows are
// idempotently overwritten with the same final values, and duplicate event logging is
// prevented by checking whether this sourceSessionId has already been ingested.
async function syncAdaptiveReport(userId, report) {
  if (!report || !Array.isArray(report.per_topic)) {
    const err = new Error('report.per_topic is required (pass the object returned by GET /adaptive/session/{id}/report).');
    err.status = 400;
    throw err;
  }
  const sessionId = report.session_id || null;
  const skillCache = new Map();

  const isNewSession = sessionId
    ? (await prisma.learningEvent.count({ where: { userId, sourceSessionId: sessionId } })) === 0
    : true; // no session id supplied — always log events (caller's responsibility to dedupe)

  const competencies = [];
  for (const t of report.per_topic) {
    const skillId = await resolveSkillId(t.topic, skillCache);
    const baseData = {
      theta: t.theta ?? null,
      standardError: t.standard_error ?? null,
      level: t.level ?? null,
      pKnow: t.p_know ?? null,
      masteryStatus: t.mastery_status ?? null,
      lastPracticedAt: new Date(),
    };
    const competency = await prisma.studentCompetency.upsert({
      where: { userId_skillId: { userId, skillId } },
      // Only bump the lifetime questionsAnswered counter the first time this session's
      // results are ingested — otherwise a resync of the same report would double-count.
      update: isNewSession
        ? { ...baseData, questionsAnswered: { increment: t.questions_answered ?? 0 } }
        : baseData,
      create: { userId, skillId, ...baseData, questionsAnswered: t.questions_answered ?? 0 },
    });
    competencies.push(competency);
  }

  let eventsLogged = 0;
  if (isNewSession && Array.isArray(report.history)) {
    for (const h of report.history) {
      const skillId = await resolveSkillId(h.topic, skillCache);
      const isCoding = typeof h.item_id === 'string' && h.item_id.startsWith('coding:');
      await prisma.learningEvent.create({
        data: {
          userId,
          skillId,
          type: isCoding ? 'ADAPTIVE_CODING' : 'ADAPTIVE_MCQ',
          correct: !!h.correct,
          thetaAfter: h.theta_after ?? null,
          pKnowAfter: h.p_know_after ?? null,
          sourceSessionId: sessionId,
        },
      });
      eventsLogged++;
    }
  }

  return { competencies, eventsLogged, alreadySynced: !isNewSession };
}

// Bucket thresholds mirror ai-ml-service's adaptive_engine._mastery_status() exactly, so an
// interview-derived competency reads on the same 4-label scale as an adaptive-quiz-derived
// one instead of inventing a second vocabulary for the Dashboard to reconcile.
function masteryStatusForPKnow(pKnow) {
  if (pKnow < 0.4) return 'Not Started';
  if (pKnow < 0.7) return 'Developing';
  if (pKnow < 0.95) return 'Approaching Mastery';
  return 'Mastered';
}

// Ingests one finished AI Mock Interviewer session (the `session_summary` object returned by
// ai-ml-service's interview_nlp._summarize_session(), via POST /interview/session/respond
// once session_finished is true) for a user. Each of the 4 rubric competencies
// (Communication, Technical Depth, Problem Solving (STAR), Confidence) becomes/updates its
// own Skill node and StudentCompetency row — deliberately using the SAME skill names an
// adaptive-quiz topic or a future resume-parsing writer might use (e.g. "Communication"),
// so the Digital Twin's competency vector is genuinely unified across modules rather than
// siloed per-feature. No theta/standardError/level here (that's IRT-specific, from the
// adaptive engine only) — only pKnow, derived deterministically from the rubric's own
// 0-100 score (score / 100), never a separately-fabricated confidence number.
// Idempotent per sessionId, same contract as syncAdaptiveReport above.
async function syncInterviewSession(userId, { sessionId, role, domainFocus, sessionSummary } = {}) {
  if (!sessionSummary || typeof sessionSummary.competency_rubric !== 'object' || !sessionSummary.competency_rubric) {
    const err = new Error('sessionSummary.competency_rubric is required (pass the session_summary object returned once an interview session finishes).');
    err.status = 400;
    throw err;
  }
  const skillCache = new Map();
  const isNewSession = sessionId
    ? (await prisma.learningEvent.count({ where: { userId, sourceSessionId: sessionId, type: 'INTERVIEW_RUBRIC' } })) === 0
    : true;

  const competencies = [];
  const turnsAnswered = sessionSummary.turns_completed || 0;
  for (const [skillName, score0to100] of Object.entries(sessionSummary.competency_rubric)) {
    const skillId = await resolveSkillId(skillName, skillCache);
    const pKnow = Math.max(0, Math.min(1, score0to100 / 100));
    const baseData = {
      pKnow,
      masteryStatus: masteryStatusForPKnow(pKnow),
      lastPracticedAt: new Date(),
    };
    const competency = await prisma.studentCompetency.upsert({
      where: { userId_skillId: { userId, skillId } },
      update: isNewSession
        ? { ...baseData, questionsAnswered: { increment: turnsAnswered } }
        : baseData,
      create: { userId, skillId, ...baseData, questionsAnswered: turnsAnswered },
    });
    competencies.push(competency);

    if (isNewSession) {
      await prisma.learningEvent.create({
        data: {
          userId,
          skillId,
          type: 'INTERVIEW_RUBRIC',
          correct: score0to100 >= 60, // same rough pass line the rubric itself uses for "weakest_competency" framing
          pKnowAfter: pKnow,
          sourceSessionId: sessionId || null,
        },
      });
    }
  }

  return { competencies, role: role || null, domainFocus: domainFocus || null, alreadySynced: !isNewSession };
}

// Ingests one ai-ml-service POST /match/resume-jd/explain response for a user — the third
// Digital Twin writer, alongside syncAdaptiveReport (quiz/coding) and syncInterviewSession
// (mock interview). Uses the SAME skill-name space as the other two writers (resolveSkillId),
// so a skill like "Docker" reads as one unified competency row regardless of which module
// last touched it, per the same reasoning as syncInterviewSession above.
//
// IMPORTANT difference from the other two writers: a resume listing is self-reported, never
// tested, so this function must never let it overwrite or downgrade a value the student
// actually earned via an adaptive quiz or interview. Only `matched_skills` (skills the resume
// evidences — exact listing or a strong semantic match) are considered, and even then only
// when the competency has NO existing pKnow at all; if one exists (from any source), the
// resume evidence is still logged as a LearningEvent for provenance/history, but the
// StudentCompetency row itself is left untouched. `missing_skills` /
// `partially_matched_skills` are intentionally NOT written here at all — recording "the
// twin knows this skill" from a match the student doesn't actually have would be exactly
// the kind of fabricated competency signal spec §33 rules out. For a graph-based explanation
// of why a missing skill matters (prerequisites, what it unlocks), call the existing
// GET /api/twin/gap-analysis with that skill as the target — reusing the Knowledge Graph
// instead of duplicating gap logic here.
async function syncResumeMatch(userId, { source, targetRole, matchResult } = {}) {
  if (!matchResult || !Array.isArray(matchResult.matched_skills)) {
    const err = new Error('matchResult.matched_skills is required (pass the object returned by POST /match/resume-jd/explain on ai-ml-service).');
    err.status = 400;
    throw err;
  }
  const skillCache = new Map();
  const competenciesWritten = [];
  const skillsSkippedAlreadyVerified = [];

  for (const m of matchResult.matched_skills) {
    const skillName = typeof m === 'string' ? m : m.skill;
    if (!skillName) continue;
    const skillId = await resolveSkillId(skillName, skillCache);
    const existing = await prisma.studentCompetency.findUnique({
      where: { userId_skillId: { userId, skillId } },
    });
    const alreadyHasEvidence = existing && existing.pKnow !== null && existing.pKnow !== undefined;

    if (!alreadyHasEvidence) {
      const competency = await prisma.studentCompetency.upsert({
        where: { userId_skillId: { userId, skillId } },
        update: {
          pKnow: RESUME_EVIDENCE_PKNOW,
          masteryStatus: masteryStatusForPKnow(RESUME_EVIDENCE_PKNOW),
          lastPracticedAt: new Date(),
        },
        create: {
          userId,
          skillId,
          pKnow: RESUME_EVIDENCE_PKNOW,
          masteryStatus: masteryStatusForPKnow(RESUME_EVIDENCE_PKNOW),
          questionsAnswered: 0,
          lastPracticedAt: new Date(),
        },
      });
      competenciesWritten.push(competency);
    } else {
      skillsSkippedAlreadyVerified.push(skillName);
    }

    // Logged unconditionally (even when the competency row itself wasn't touched) so the
    // resume-match event still shows up in this skill's history/audit trail.
    await prisma.learningEvent.create({
      data: {
        userId,
        skillId,
        type: 'RESUME_SKILL_EVIDENCE',
        correct: true, // this event type only ever records "resume evidences this skill"
        pKnowAfter: alreadyHasEvidence ? existing.pKnow : RESUME_EVIDENCE_PKNOW,
        sourceSessionId: source || null,
      },
    });
  }

  return {
    competenciesWritten,
    skillsSkippedAlreadyVerified,
    missingSkillCount: (matchResult.missing_skills || []).length,
    partiallyMatchedSkillCount: (matchResult.partially_matched_skills || []).length,
    targetRole: targetRole || null,
  };
}

// Full competency vector for the Dashboard: every skill this user has any tracked data for,
// resolved with skill name/category, plus the pure-function rollups from digitalTwin.js.
async function getCompetencyVector(userId) {
  const rows = await prisma.studentCompetency.findMany({
    where: { userId },
    include: { skill: { select: { name: true, category: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  const competencies = rows.map((r) => ({
    skillId: r.skillId,
    skillName: r.skill.name,
    category: r.skill.category,
    theta: r.theta,
    standardError: r.standardError,
    level: r.level,
    pKnow: r.pKnow,
    masteryStatus: r.masteryStatus,
    questionsAnswered: r.questionsAnswered,
    lastPracticedAt: r.lastPracticedAt,
  }));
  return {
    competencies,
    overallMastery: twin.overallMastery(competencies),
    weakestSkills: twin.weakestSkills(competencies, 3),
    strongestSkills: twin.strongestSkills(competencies, 3),
    byCategory: twin.byCategoryRollup(competencies),
  };
}

// The pay-off for the whole Digital Twin: gap-analysis that reads the user's OWN mastery
// state instead of requiring the caller to pass a `known` list by hand (compare to
// GET /api/graph/gap-analysis, which stays mastery-source-agnostic for callers that don't
// have a logged-in user's data, e.g. an anonymous "explore this skill" page).
async function gapAnalysisForUser(userId, targetSkillName, threshold) {
  const rows = await prisma.studentCompetency.findMany({
    where: { userId },
    include: { skill: { select: { name: true } } },
  });
  const competencies = rows.map((r) => ({ skillName: r.skill.name, pKnow: r.pKnow }));
  const known = twin.namesAboveThreshold(competencies, threshold);
  return graphRepo.gapAnalysisForSkill(targetSkillName, known);
}

module.exports = {
  syncAdaptiveReport,
  syncInterviewSession,
  syncResumeMatch,
  getCompetencyVector,
  gapAnalysisForUser,
};
