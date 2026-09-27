const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const repo = require('../services/knowledgeGraphRepo');

const router = express.Router();

const VALID_TYPES = ['PREREQUISITE_OF', 'RELATED_TO', 'ADVANCED_VERSION_OF', 'REQUIRED_BY', 'COMMONLY_CONFUSED_WITH'];

// --- GET /api/graph/skills -------------------------------------------------------------------
// Public read: powers skill pickers / roadmap UI. ?category= filters (e.g. "Data Structures",
// matching the adaptive-engine topic names 1:1 — see schema.prisma comment on Skill.category).
router.get('/skills', async (req, res) => {
  try {
    const skills = await repo.listSkills(req.query.category);
    res.json({ skills });
  } catch (err) {
    res.status(500).json({ error: 'Could not load skills.' });
  }
});

// --- GET /api/graph/skills/:name/prerequisites -----------------------------------------------
// Full transitive prerequisite chain for a skill, topologically ordered (a valid learn order).
router.get('/skills/:name/prerequisites', async (req, res) => {
  try {
    const result = await repo.getPrerequisitesForSkill(req.params.name);
    if (!result) return res.status(404).json({ error: `Unknown skill: ${req.params.name}` });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Could not compute prerequisites.' });
  }
});

// --- GET /api/graph/skills/:name/related?type=RELATED_TO --------------------------------------
router.get('/skills/:name/related', async (req, res) => {
  try {
    const type = req.query.type || 'RELATED_TO';
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    }
    const result = await repo.getRelatedForSkill(req.params.name, type);
    if (!result) return res.status(404).json({ error: `Unknown skill: ${req.params.name}` });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Could not load related skills.' });
  }
});

// --- GET /api/graph/gap-analysis?target=X&known=A,B,C ------------------------------------------
// The integration point for roadmap/career-path/tutor modules. `known` is a caller-supplied
// comma-separated list of mastered skill names — this endpoint deliberately does NOT read the
// student's BKT/mastery state itself (that lives in ai-ml-service's session store today, with
// no persisted per-user link yet — that link is the Digital Twin phase's job). Keeping this
// endpoint mastery-source-agnostic means it already works for a quiz-based "known skills"
// checklist today and for the future Digital Twin without an API change.
router.get('/gap-analysis', async (req, res) => {
  try {
    const { target, known } = req.query;
    if (!target) return res.status(400).json({ error: 'target query param is required.' });
    const masteredNames = known ? String(known).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const result = await repo.gapAnalysisForSkill(target, masteredNames);
    if (!result) return res.status(404).json({ error: `Unknown skill: ${target}` });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Could not run gap analysis.' });
  }
});

// --- POST /api/graph/skills (admin only) -------------------------------------------------------
router.post('/skills', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, category, description } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required.' });
    const skill = await repo.createSkill({ name, category, description });
    res.status(201).json({ skill });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: `Skill "${req.body.name}" already exists.` });
    res.status(500).json({ error: 'Could not create skill.' });
  }
});

// --- POST /api/graph/relations (admin only) ------------------------------------------------------
// Rejects with 409 if the new edge would create a cycle in an ordered relation type (see
// knowledgeGraphRepo.createRelation) — this is the actual data-integrity guarantee behind
// every prerequisite-chain/gap-analysis computation above.
router.post('/relations', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { fromSkillId, toSkillId, type, weight } = req.body || {};
    if (!fromSkillId || !toSkillId) return res.status(400).json({ error: 'fromSkillId and toSkillId are required.' });
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    const relation = await repo.createRelation({ fromSkillId, toSkillId, type, weight });
    res.status(201).json({ relation });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message });
    if (err.code === 'P2002') return res.status(409).json({ error: 'This exact relation already exists.' });
    res.status(500).json({ error: 'Could not create relation.' });
  }
});

// --- DELETE /api/graph/relations/:id (admin only) --------------------------------------------
router.delete('/relations/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await repo.deleteRelation(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete relation.' });
  }
});

module.exports = router;
