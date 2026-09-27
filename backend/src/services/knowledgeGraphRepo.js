// Prisma-backed data access for the Competency Knowledge Graph. Thin by design: this file's
// only job is to load/write rows and hand plain {id, ...} objects to the pure algorithms in
// knowledgeGraph.js — no graph logic lives here, so the algorithms stay testable without a
// database (see tests/knowledgeGraph.test.js) while this layer stays trivial to review for
// correctness of the actual DB reads/writes.
const prisma = require('../db');
const graph = require('./knowledgeGraph');

async function loadAllRelations() {
  return prisma.skillRelation.findMany({ select: { id: true, fromSkillId: true, toSkillId: true, type: true, weight: true } });
}

async function getSkillByName(name) {
  return prisma.skill.findUnique({ where: { name } });
}

async function listSkills(category) {
  return prisma.skill.findMany({
    where: category ? { category } : undefined,
    orderBy: { name: 'asc' },
  });
}

async function createSkill({ name, category, description }) {
  return prisma.skill.create({ data: { name, category: category || null, description: description || null } });
}

// Validates acyclicity (for PREREQUISITE_OF / ADVANCED_VERSION_OF) against the current DB
// state before writing. Throws a plain Error with `.status = 409` on conflict so routes can
// translate it straight into an HTTP response.
async function createRelation({ fromSkillId, toSkillId, type, weight }) {
  if (graph.ORDERED_TYPES.has(type)) {
    const existing = await loadAllRelations();
    if (graph.wouldCreateCycle(fromSkillId, toSkillId, existing, type)) {
      const err = new Error(
        `Adding "${fromSkillId}" -> "${toSkillId}" (${type}) would create a cycle in the prerequisite graph.`
      );
      err.status = 409;
      throw err;
    }
  }
  return prisma.skillRelation.create({ data: { fromSkillId, toSkillId, type, weight: weight ?? 1.0 } });
}

async function deleteRelation(id) {
  return prisma.skillRelation.delete({ where: { id } });
}

// Direct + transitive prerequisites of a named skill, resolved to full skill records and
// topologically ordered — this is what the frontend/roadmap engine actually wants to render.
async function getPrerequisitesForSkill(name) {
  const skill = await getSkillByName(name);
  if (!skill) return null;
  const relations = await loadAllRelations();
  const prereqIds = graph.transitivePrerequisites(skill.id, relations);
  const order = graph.topologicalOrder([...prereqIds, skill.id], relations);
  const skills = await prisma.skill.findMany({ where: { id: { in: [...prereqIds, skill.id] } } });
  const byId = new Map(skills.map((s) => [s.id, s]));
  return {
    skill,
    prerequisites: order.filter((id) => id !== skill.id).map((id) => byId.get(id)),
  };
}

async function getRelatedForSkill(name, type) {
  const skill = await getSkillByName(name);
  if (!skill) return null;
  const relations = await loadAllRelations();
  const neighborIds = graph.directNeighbors(skill.id, relations, type);
  const skills = await prisma.skill.findMany({ where: { id: { in: neighborIds } } });
  return { skill, related: skills, relationType: type };
}

// The main integration point other modules (roadmap, career path, tutor) will eventually
// call: given a target skill name and a list of already-mastered skill names, what's left
// to learn and in what order. `masteredNames` mastery-threshold decisions (e.g. BKT
// p_know >= 0.7) are the caller's responsibility — this function only does graph traversal.
async function gapAnalysisForSkill(targetName, masteredNames = []) {
  const target = await getSkillByName(targetName);
  if (!target) return null;
  const relations = await loadAllRelations();
  const masteredSkills = masteredNames.length
    ? await prisma.skill.findMany({ where: { name: { in: masteredNames } } })
    : [];
  const masteredIds = masteredSkills.map((s) => s.id);
  const involvedIds = Array.from(new Set([
    target.id, ...masteredIds, ...graph.transitivePrerequisites(target.id, relations),
  ]));
  const involvedSkills = await prisma.skill.findMany({ where: { id: { in: involvedIds } } });
  const skillsById = new Map(involvedSkills.map((s) => [s.id, s]));
  return graph.gapAnalysis(target.id, masteredIds, relations, skillsById);
}

module.exports = {
  loadAllRelations,
  getSkillByName,
  listSkills,
  createSkill,
  createRelation,
  deleteRelation,
  getPrerequisitesForSkill,
  getRelatedForSkill,
  gapAnalysisForSkill,
};
