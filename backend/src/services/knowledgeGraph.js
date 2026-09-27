// Pure graph algorithms over a plain { skills, relations } object.
//
// Deliberately decoupled from Prisma: every function here takes plain arrays in and returns
// plain data out, so it's unit-testable with zero database/framework setup (see
// tests/knowledgeGraph.test.js) and reusable by anything that can produce that shape (the
// ai-ml-service Python side could consume the same JSON contract via the REST layer in
// routes/graph.js without needing its own copy of this logic).
//
// Shapes:
//   skill    = { id, name, category }
//   relation = { fromSkillId, toSkillId, type, weight }
//   type is one of: PREREQUISITE_OF | RELATED_TO | ADVANCED_VERSION_OF | REQUIRED_BY |
//                    COMMONLY_CONFUSED_WITH
//
// Direction convention (full rationale in schema.prisma): PREREQUISITE_OF's fromSkillId ->
// toSkillId means "learn fromSkill before toSkill" and IS used for topological ordering
// below. ADVANCED_VERSION_OF is also directional and independently kept acyclic (see
// ORDERED_TYPES) but points the opposite chronological way (fromSkill is the advanced form,
// so toSkill actually comes first) — it is intentionally NOT fed into topologicalOrder/
// gapAnalysis to avoid mixing two "which side comes first" conventions. RELATED_TO /
// REQUIRED_BY / COMMONLY_CONFUSED_WITH are non-ordered annotations, not subject to either.

const ORDERED_TYPES = new Set(['PREREQUISITE_OF', 'ADVANCED_VERSION_OF']); // acyclicity-checked at write time

function edgesOfType(relations, type) {
  return relations.filter((r) => r.type === type);
}

function buildAdjacency(relations, type) {
  const adj = new Map(); // fromId -> [toId, ...]
  for (const r of edgesOfType(relations, type)) {
    if (!adj.has(r.fromSkillId)) adj.set(r.fromSkillId, []);
    adj.get(r.fromSkillId).push(r.toSkillId);
  }
  return adj;
}

function buildReverseAdjacency(relations, type) {
  const radj = new Map(); // toId -> [fromId, ...]
  for (const r of edgesOfType(relations, type)) {
    if (!radj.has(r.toSkillId)) radj.set(r.toSkillId, []);
    radj.get(r.toSkillId).push(r.fromSkillId);
  }
  return radj;
}

// All skills that must come before `targetId`, transitively, walking PREREQUISITE_OF edges
// backwards from the target. Returns skill IDs only (no duplicates), NOT including the
// target itself.
function transitivePrerequisites(targetId, relations, type = 'PREREQUISITE_OF') {
  const radj = buildReverseAdjacency(relations, type);
  const seen = new Set();
  const queue = [targetId];
  while (queue.length) {
    const cur = queue.shift();
    const preds = radj.get(cur) || [];
    for (const p of preds) {
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return Array.from(seen);
}

// Detects whether adding a new edge (fromId -> toId) of `type` would create a cycle, given
// the existing relations of that same type. Used at write time (see knowledgeGraphRepo.js)
// since Postgres has no native DAG constraint — this is the actual integrity check.
function wouldCreateCycle(fromId, toId, existingRelations, type) {
  if (fromId === toId) return true;
  // A cycle would be created iff `toId` can already reach `fromId` via existing edges of
  // this type — i.e. there's already a path toId -> ... -> fromId, and adding fromId -> toId
  // would close the loop.
  const adj = buildAdjacency(existingRelations, type);
  const seen = new Set([toId]);
  const queue = [toId];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === fromId) return true;
    for (const next of adj.get(cur) || []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

// Kahn's algorithm: valid learning order for a subset of skill IDs, respecting
// PREREQUISITE_OF edges restricted to that subset. Throws if the restricted subgraph has a
// cycle (shouldn't happen if writes are validated via wouldCreateCycle, but this is the
// last line of defense against bad data).
function topologicalOrder(skillIds, relations, type = 'PREREQUISITE_OF') {
  const idSet = new Set(skillIds);
  const inDegree = new Map(skillIds.map((id) => [id, 0]));
  const adj = new Map(skillIds.map((id) => [id, []]));

  for (const r of edgesOfType(relations, type)) {
    if (idSet.has(r.fromSkillId) && idSet.has(r.toSkillId)) {
      adj.get(r.fromSkillId).push(r.toSkillId);
      inDegree.set(r.toSkillId, (inDegree.get(r.toSkillId) || 0) + 1);
    }
  }

  const queue = skillIds.filter((id) => inDegree.get(id) === 0);
  const order = [];
  while (queue.length) {
    // Stable-ish ordering: process in the order skills were provided so output is
    // deterministic for a given input, not dependent on Map iteration quirks.
    queue.sort((a, b) => skillIds.indexOf(a) - skillIds.indexOf(b));
    const cur = queue.shift();
    order.push(cur);
    for (const next of adj.get(cur) || []) {
      inDegree.set(next, inDegree.get(next) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }

  if (order.length !== skillIds.length) {
    throw new Error('Cycle detected in PREREQUISITE_OF subgraph — data integrity issue, cannot compute a learning order.');
  }
  return order;
}

// The core integration point for roadmap/career-path/tutor modules: given a target skill and
// the set of skills the student has already mastered (skill IDs — the caller decides the
// mastery threshold, e.g. BKT p_know >= 0.7), returns every prerequisite still missing, in a
// valid order to learn them in, plus whether the target itself is already satisfied.
function gapAnalysis(targetId, masteredIds, relations, skillsById) {
  const masteredSet = new Set(masteredIds);
  const allPrereqs = transitivePrerequisites(targetId, relations);
  const missingIds = allPrereqs.filter((id) => !masteredSet.has(id));
  const needsTarget = !masteredSet.has(targetId);
  const toLearn = needsTarget ? [...missingIds, targetId] : missingIds;
  let learnOrder;
  try {
    learnOrder = topologicalOrder(toLearn, relations);
  } catch (err) {
    // Data-integrity fallback: surface the raw (unordered) list rather than failing the whole
    // request — an unordered gap list is still useful, just not sequenced.
    learnOrder = toLearn;
  }
  return {
    targetSatisfied: !needsTarget,
    missingPrerequisiteIds: missingIds,
    learnOrderIds: learnOrder,
    missingPrerequisites: skillsById ? missingIds.map((id) => skillsById.get(id)).filter(Boolean) : undefined,
    learnOrder: skillsById ? learnOrder.map((id) => skillsById.get(id)).filter(Boolean) : undefined,
  };
}

// Direct (non-transitive) neighbors of a skill for a given relation type, in both directions
// — used for RELATED_TO / COMMONLY_CONFUSED_WITH / REQUIRED_BY, which aren't ordered.
function directNeighbors(skillId, relations, type) {
  const out = relations.filter((r) => r.fromSkillId === skillId && r.type === type).map((r) => r.toSkillId);
  const back = relations.filter((r) => r.toSkillId === skillId && r.type === type).map((r) => r.fromSkillId);
  return Array.from(new Set([...out, ...back]));
}

module.exports = {
  ORDERED_TYPES,
  buildAdjacency,
  buildReverseAdjacency,
  transitivePrerequisites,
  wouldCreateCycle,
  topologicalOrder,
  gapAnalysis,
  directNeighbors,
};
