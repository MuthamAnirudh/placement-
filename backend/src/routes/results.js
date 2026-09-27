const express = require('express');
const prisma = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// PLACEMENT_PREDICTION (AI Placement Predictor / Readiness Forecast tab) and MIRROR_MENTOR
// (MirrorMentor-X coach + Elevator Pitch Analyzer) were added so all 5 AI Tools tabs get the
// same persistence + peer-benchmarking treatment as Quiz/Interview/Roadmap/Radar/Resume
// Analysis already had — see prisma/migrations/20260912000000_add_predictor_mirrormentor_result_types.
const RESULT_TYPES = ['QUIZ', 'INTERVIEW', 'ROADMAP', 'RADAR', 'RESUME_ANALYSIS', 'PLACEMENT_PREDICTION', 'MIRROR_MENTOR'];

// --- POST /api/results ----------------------------------------------------------------------
// Saves one result of any type. Called from the frontend right after a quiz/interview/
// roadmap/radar/resume-analysis session finishes. `payload` is stored as-is (whatever JSON
// shape that feature already produces) — summaryScore/summaryLabel/topic are pulled out
// separately purely to make the dashboard and peer-benchmarking queries cheap.
router.post('/', requireAuth, async (req, res) => {
  try {
    const { type, topic, summaryScore, summaryLabel, payload } = req.body || {};
    if (!RESULT_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${RESULT_TYPES.join(', ')}` });
    }
    if (payload === undefined || payload === null) {
      return res.status(400).json({ error: 'payload is required.' });
    }
    const result = await prisma.result.create({
      data: {
        userId: req.user.sub,
        type,
        topic: topic || null,
        summaryScore: summaryScore !== undefined && summaryScore !== null ? Number(summaryScore) : null,
        summaryLabel: summaryLabel || null,
        payload,
      },
    });
    res.status(201).json({ result });
  } catch (err) {
    res.status(500).json({ error: 'Could not save result.' });
  }
});

// --- GET /api/results ------------------------------------------------------------------------
// Lists the logged-in user's own results, optionally filtered by ?type=QUIZ, newest first.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { type, topic, limit } = req.query;
    const results = await prisma.result.findMany({
      where: {
        userId: req.user.sub,
        ...(type ? { type } : {}),
        ...(topic ? { topic } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(limit) || 50, 200),
    });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Could not load results.' });
  }
});

// --- DELETE /api/results/:id -----------------------------------------------------------------
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await prisma.result.findUnique({ where: { id: req.params.id } });
    if (!result || result.userId !== req.user.sub) return res.status(404).json({ error: 'Result not found.' });
    await prisma.result.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete result.' });
  }
});

// --- GET /api/results/dashboard ----------------------------------------------------------------
// Powers the "My Progress" panel: counts + trend (score over time) per result type, so the
// frontend can chart improvement across sessions instead of only ever showing the latest one.
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const results = await prisma.result.findMany({
      where: { userId: req.user.sub },
      orderBy: { createdAt: 'asc' },
      select: { type: true, topic: true, summaryScore: true, summaryLabel: true, createdAt: true },
    });
    const byType = {};
    for (const t of RESULT_TYPES) byType[t] = { count: 0, trend: [], latest: null, best: null };
    for (const r of results) {
      const bucket = byType[r.type];
      bucket.count += 1;
      if (r.summaryScore !== null) {
        bucket.trend.push({ x: r.createdAt, y: r.summaryScore, topic: r.topic });
        if (bucket.best === null || r.summaryScore > bucket.best) bucket.best = r.summaryScore;
      }
      bucket.latest = { score: r.summaryScore, label: r.summaryLabel, topic: r.topic, at: r.createdAt };
    }
    res.json({ totalSessions: results.length, byType });
  } catch (err) {
    res.status(500).json({ error: 'Could not load dashboard.' });
  }
});

// --- GET /api/results/peer-stats ---------------------------------------------------------------
// Anonymized feed for the new AI/ML "Peer Benchmarking" feature: returns just the numeric
// scores for a given type (+ optional topic) across ALL users — no names, emails, or user
// IDs — so ai-ml-service can compute a percentile/z-score without ever seeing who anyone is.
// `optionalAuth` because this is population data, not personal data; being logged in only
// lets the caller also request `excludeSelf=true` to compare against everyone but themselves.
router.get('/peer-stats', optionalAuth, async (req, res) => {
  try {
    const { type, topic, excludeSelf, limit } = req.query;
    if (!RESULT_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${RESULT_TYPES.join(', ')}` });
    }
    const results = await prisma.result.findMany({
      where: {
        type,
        ...(topic ? { topic } : {}),
        summaryScore: { not: null },
        ...(excludeSelf === 'true' && req.user ? { userId: { not: req.user.sub } } : {}),
      },
      select: { summaryScore: true },
      take: Math.min(Number(limit) || 5000, 5000),
    });
    res.json({ scores: results.map((r) => r.summaryScore), count: results.length });
  } catch (err) {
    res.status(500).json({ error: 'Could not load peer stats.' });
  }
});

module.exports = router;
