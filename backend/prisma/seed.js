// Seeds the Competency Knowledge Graph with a starter skill set.
//
// Skill `category` values match the adaptive-engine topic names EXACTLY (see
// ai-ml-service/data/adaptive_question_bank.json TOPICS: Data Structures, Algorithms,
// Networks, OOP, Operating Systems, Python, SQL, Web Development) — a BKT/IRT topic mastery
// result can be looked up as a Skill by that same name/category with no translation layer.
//
// This is a deliberately modest starter graph (~45 skills, ~55 relations), not a claimed-
// complete CS curriculum — meant to be extended by admins via POST /api/graph/skills and
// /api/graph/relations (or a future admin UI), not to be the final word on prerequisite
// structure. Idempotent: uses upsert, safe to re-run.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// [name, category] — category doubles as the top-level "topic" skill's own name.
const SKILLS = [
  // Data Structures
  ['Data Structures', 'Data Structures'],
  ['Arrays', 'Data Structures'],
  ['Linked Lists', 'Data Structures'],
  ['Stacks', 'Data Structures'],
  ['Queues', 'Data Structures'],
  ['Hash Tables', 'Data Structures'],
  ['Trees', 'Data Structures'],
  ['Graphs', 'Data Structures'],

  // Algorithms
  ['Algorithms', 'Algorithms'],
  ['Recursion', 'Algorithms'],
  ['Sorting', 'Algorithms'],
  ['Searching', 'Algorithms'],
  ['Greedy Algorithms', 'Algorithms'],
  ['Dynamic Programming', 'Algorithms'],

  // Networks
  ['Networks', 'Networks'],
  ['OSI Model', 'Networks'],
  ['TCP/IP', 'Networks'],
  ['Routing', 'Networks'],
  ['DNS', 'Networks'],

  // OOP
  ['OOP', 'OOP'],
  ['Classes & Objects', 'OOP'],
  ['Inheritance', 'OOP'],
  ['Polymorphism', 'OOP'],
  ['Encapsulation', 'OOP'],
  ['Design Patterns', 'OOP'],

  // Operating Systems
  ['Operating Systems', 'Operating Systems'],
  ['Processes', 'Operating Systems'],
  ['Threads & Concurrency', 'Operating Systems'],
  ['Memory Management', 'Operating Systems'],
  ['CPU Scheduling', 'Operating Systems'],
  ['Deadlocks', 'Operating Systems'],

  // Python
  ['Python', 'Python'],
  ['Python Syntax Basics', 'Python'],
  ['Python Data Structures', 'Python'],
  ['Python OOP', 'Python'],
  ['Decorators & Generators', 'Python'],

  // SQL
  ['SQL', 'SQL'],
  ['Basic Queries (SELECT/WHERE)', 'SQL'],
  ['Joins', 'SQL'],
  ['Subqueries', 'SQL'],
  ['Indexing & Query Optimization', 'SQL'],
  ['Transactions', 'SQL'],

  // Web Development
  ['Web Development', 'Web Development'],
  ['HTML & CSS', 'Web Development'],
  ['JavaScript', 'Web Development'],
  ['REST APIs', 'Web Development'],
  ['Frontend Frameworks (React/Vue)', 'Web Development'],
  ['Container Networking', 'Web Development'],
];

// [fromName, toName, type, weight?]
const RELATIONS = [
  // --- Data Structures chain (mirrors the doc's own worked example) ---
  ['Arrays', 'Linked Lists', 'PREREQUISITE_OF'],
  ['Linked Lists', 'Stacks', 'PREREQUISITE_OF'],
  ['Linked Lists', 'Queues', 'PREREQUISITE_OF'],
  ['Linked Lists', 'Trees', 'PREREQUISITE_OF'],
  ['Arrays', 'Hash Tables', 'PREREQUISITE_OF'],
  ['Trees', 'Graphs', 'PREREQUISITE_OF'],
  ['Stacks', 'Graphs', 'PREREQUISITE_OF'],
  ['Queues', 'Graphs', 'PREREQUISITE_OF'],
  ['Stacks', 'Queues', 'COMMONLY_CONFUSED_WITH'],
  ['Data Structures', 'Algorithms', 'RELATED_TO'],

  // --- Algorithms ---
  ['Recursion', 'Dynamic Programming', 'PREREQUISITE_OF'],
  ['Arrays', 'Dynamic Programming', 'PREREQUISITE_OF'],
  ['Graphs', 'Dynamic Programming', 'PREREQUISITE_OF'],
  ['Sorting', 'Searching', 'RELATED_TO'],
  ['Dynamic Programming', 'Greedy Algorithms', 'RELATED_TO'],
  ['Dynamic Programming', 'Recursion', 'ADVANCED_VERSION_OF'],
  ['Graphs', 'Dynamic Programming', 'REQUIRED_BY'],

  // --- Networks ---
  ['OSI Model', 'TCP/IP', 'PREREQUISITE_OF'],
  ['TCP/IP', 'Routing', 'PREREQUISITE_OF'],
  ['TCP/IP', 'DNS', 'PREREQUISITE_OF'],
  ['TCP/IP', 'Container Networking', 'PREREQUISITE_OF'],

  // --- OOP ---
  ['Classes & Objects', 'Inheritance', 'PREREQUISITE_OF'],
  ['Classes & Objects', 'Encapsulation', 'PREREQUISITE_OF'],
  ['Inheritance', 'Polymorphism', 'PREREQUISITE_OF'],
  ['Polymorphism', 'Design Patterns', 'PREREQUISITE_OF'],
  ['Encapsulation', 'Design Patterns', 'PREREQUISITE_OF'],

  // --- Operating Systems ---
  ['Processes', 'Threads & Concurrency', 'PREREQUISITE_OF'],
  ['Processes', 'CPU Scheduling', 'PREREQUISITE_OF'],
  ['Threads & Concurrency', 'Deadlocks', 'PREREQUISITE_OF'],
  ['Processes', 'Memory Management', 'RELATED_TO'],

  // --- Python ---
  ['Python Syntax Basics', 'Python Data Structures', 'PREREQUISITE_OF'],
  ['Python Data Structures', 'Python OOP', 'PREREQUISITE_OF'],
  ['Python OOP', 'Decorators & Generators', 'PREREQUISITE_OF'],
  ['Classes & Objects', 'Python OOP', 'PREREQUISITE_OF'],
  ['Arrays', 'Python Data Structures', 'RELATED_TO'],

  // --- SQL ---
  ['Basic Queries (SELECT/WHERE)', 'Joins', 'PREREQUISITE_OF'],
  ['Joins', 'Subqueries', 'PREREQUISITE_OF'],
  ['Subqueries', 'Indexing & Query Optimization', 'PREREQUISITE_OF'],
  ['Basic Queries (SELECT/WHERE)', 'Transactions', 'PREREQUISITE_OF'],

  // --- Web Development ---
  ['HTML & CSS', 'JavaScript', 'PREREQUISITE_OF'],
  ['JavaScript', 'REST APIs', 'PREREQUISITE_OF'],
  ['REST APIs', 'Frontend Frameworks (React/Vue)', 'PREREQUISITE_OF'],
  ['JavaScript', 'Frontend Frameworks (React/Vue)', 'PREREQUISITE_OF'],
  ['REST APIs', 'Container Networking', 'RELATED_TO'],

  // --- Cross-topic links (why this is a graph, not eight separate trees) ---
  ['Python', 'SQL', 'RELATED_TO'],
  ['OOP', 'Design Patterns', 'RELATED_TO'],
  ['Web Development', 'Networks', 'RELATED_TO'],
];

async function main() {
  const nameToId = new Map();

  for (const [name, category] of SKILLS) {
    const skill = await prisma.skill.upsert({
      where: { name },
      update: { category },
      create: { name, category },
    });
    nameToId.set(name, skill.id);
  }
  console.log(`Upserted ${SKILLS.length} skills.`);

  let created = 0, skipped = 0;
  for (const [fromName, toName, type] of RELATIONS) {
    const fromSkillId = nameToId.get(fromName);
    const toSkillId = nameToId.get(toName);
    if (!fromSkillId || !toSkillId) {
      console.warn(`Skipping relation referencing unknown skill: ${fromName} -> ${toName}`);
      continue;
    }
    try {
      await prisma.skillRelation.upsert({
        where: { fromSkillId_toSkillId_type: { fromSkillId, toSkillId, type } },
        update: {},
        create: { fromSkillId, toSkillId, type },
      });
      created++;
    } catch (err) {
      console.warn(`Skipped relation ${fromName} -> ${toName} (${type}): ${err.message}`);
      skipped++;
    }
  }
  console.log(`Upserted ${created} relations (${skipped} skipped).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
