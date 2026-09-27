-- Adds the Student Digital Twin persistence layer: a per-(user, skill) current-state
-- snapshot (StudentCompetency) plus an append-only interaction log (LearningEvent).
-- Purely additive — no existing table, column, or row is touched.

-- CreateEnum
CREATE TYPE "LearningEventType" AS ENUM ('ADAPTIVE_MCQ', 'ADAPTIVE_CODING');

-- CreateTable
CREATE TABLE "StudentCompetency" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "theta" DOUBLE PRECISION,
    "standardError" DOUBLE PRECISION,
    "level" TEXT,
    "pKnow" DOUBLE PRECISION,
    "masteryStatus" TEXT,
    "questionsAnswered" INTEGER NOT NULL DEFAULT 0,
    "lastPracticedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentCompetency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "type" "LearningEventType" NOT NULL,
    "correct" BOOLEAN NOT NULL,
    "thetaAfter" DOUBLE PRECISION,
    "pKnowAfter" DOUBLE PRECISION,
    "sourceSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StudentCompetency_userId_skillId_key" ON "StudentCompetency"("userId", "skillId");

-- CreateIndex
CREATE INDEX "StudentCompetency_userId_idx" ON "StudentCompetency"("userId");

-- CreateIndex
CREATE INDEX "StudentCompetency_skillId_idx" ON "StudentCompetency"("skillId");

-- CreateIndex
CREATE INDEX "LearningEvent_userId_skillId_idx" ON "LearningEvent"("userId", "skillId");

-- CreateIndex
CREATE INDEX "LearningEvent_sourceSessionId_idx" ON "LearningEvent"("sourceSessionId");

-- AddForeignKey
ALTER TABLE "StudentCompetency" ADD CONSTRAINT "StudentCompetency_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentCompetency" ADD CONSTRAINT "StudentCompetency_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
