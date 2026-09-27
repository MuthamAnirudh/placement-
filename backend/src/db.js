// Prisma client singleton. Import this everywhere instead of `new PrismaClient()` so we
// don't exhaust Postgres connections across hot-reloads / multiple route modules.
const { PrismaClient } = require('@prisma/client');

const prisma =
  global.__prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') global.__prisma = prisma;

module.exports = prisma;
