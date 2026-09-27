const express = require('express');
const { requireAuth } = require('../middleware/auth');
const repo = require('../services/digitalTwinRepo');
const { MASTERY_THRESHOLD_FOR_PREREQUISITES } = require('../services/digitalTwin');
const banditRepo = require('../services/banditEngineRepo');
const { buildNextSkillEvidence } = require('../services/recommendationEvidence');

const router = express.Router();

// --- GET /api/twin ------------------------------------------------------------------------
// The logged-in user's full competency vector — powers the Digital Twin Dashboard.
router.get('/', requireAuth, async (req, res) => {
  try {
    const data = await repo.getCompetencyVector(req.user.sub);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Could not load competency vector.' });
  }
});

// --- POST /api/twin/sync-adaptive-report -------------------------------------------------
// Body: { report: <the JSON object returned by GET /adaptive/session/{id}/report on the
// ai-ml-service side> }. Call this once a diagnostic session finishes so its result outlives
// the ai-ml-service in-memory session store. Idempotent per report.session_id.
router.post('/sync-adaptive-report', requireAuth, async (req, res) => {
  try {
    const { report } = req.body || {};
    const result = await repo.syncAdaptiveReport(req.user.sub, report);
    res.status(201).json(result);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Could not sync adaptive report.' });
  }
});

// --- POST /api/twin/sync-interview-session -----------------------------------------------
// Body: { sessionId, role, domainFocus, sessionSummary } where sessionSummary is the object
// ai-ml-service returns as `session_summary` once POST /interview/session/respond reports
// session_finished:true. Second Digital Twin writer alongside sync-adaptive-report (see the
// schema.prisma comment on StudentCompetency) — turns the AI Mock Interviewer's per-session
// Communication/Technical Depth/Problem Solving/Confidence rubric into real competency rows
// instead of leaving interview performance stuck in the generic Result JSON blob. Idempotent
// per sessionId.
router.post('/sync-interview-session', requireAuth, async (req, res) => {
  try {
    const { sessionId, role, domainFocus, sessionSummary } = req.body || {};
    const result = await repo.syncInterviewSession(req.user.sub, { sessionId, role, domainFocus, sessionSummary });
    res.status(201).json(result);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Could not sync interview session.' });
  }
});

// --- POST /api/twin/sync-resume-match -----------------------------------------------------
// Body: { source, targetRole, matchResult } where matchResult is the object ai-ml-service
// returns from POST /match/resume-jd/explain. Third Digital Twin writer alongside
// sync-adaptive-report and sync-interview-session — see the header comment on
// digitalTwinRepo.syncResumeMatch for the (important) rule that resume evidence never
// overwrites a tested competency. Not idempotency-guarded by a session id like the other two
// (a resume match isn't a "session"); calling it again with the same matchResult is still
// safe — upserts land on the same values, and skipped-already-verified skills stay skipped.
router.post('/sync-resume-match', requireAuth, async (req, res) => {
  try {
    const { source, targetRole, matchResult } = req.body || {};
    const result = await repo.syncResumeMatch(req.user.sub, { source, targetRole, matchResult });
    res.status(201).json(result);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Could not sync resume match.' });
  }
});

// --- GET /api/twin/gap-analysis?target=X&threshold=0.7 -------------------------------------
// Like GET /api/graph/gap-analysis, but automatically uses the logged-in user's own tracked
// mastery instead of requiring a `known` list — this is the actual integration point the
// Roadmap/Career-Path modules should call once they exist.
router.get('/gap-analysis', requireAuth, async (req, res) => {
  try {
    const { target, threshold } = req.query;
    if (!target) return res.status(400).json({ error: 'target query param is required.' });
    const t = threshold !== undefined ? Number(threshold) : MASTERY_THRESHOLD_FOR_PREREQUISITES;
    if (Number.isNaN(t) || t < 0 || t > 1) return res.status(400).json({ error: 'threshold must be a number between 0 and 1.' });
    const result = await repo.gapAnalysisForUser(req.user.sub, target, t);
    if (!result) return res.status(404).json({ error: `Unknown skill: ${target}` });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Could not run gap analysis.' });
  }
});

// --- GET /api/twin/next-recommendation -----------------------------------------------------
// The Sequential Decision Engine (spec §15, scoped per the header comment in
// banditEngine.js): a LinUCB contextual bandit over "which not-yet-mastered, prerequisite-
// satisfied skill should this student practice next", trained on the student's own real
// LearningEvent history. Returns both the pick and a traceable evidence object (same
// Evidence/Factor shape as ai-ml-service's Explainable AI layer) — never a bare number.
router.get('/next-recommendation', requireAuth, async (req, res) => {
  try {
    const alpha = req.query.alpha !== undefined ? Number(req.query.alpha) : 1.0;
    if (Number.isNaN(alpha) || alpha < 0) return res.status(400).json({ error: 'alpha must be a non-negative number.' });
    const result = await banditRepo.recommendNextSkill(req.user.sub, { alpha });
    const evidence = buildNextSkillEvidence(result);
    res.json({ ...result, evidence });
  } catch (err) {
    res.status(500).json({ error: 'Could not compute next-skill recommendation.' });
  }
});

module.exports = router;
