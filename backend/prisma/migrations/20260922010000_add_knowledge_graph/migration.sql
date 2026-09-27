-- Adds the Competency Knowledge Graph (Skill nodes + typed SkillRelation edges) on top of
-- the existing schema. Purely additive — no existing table, column, or row is touched, and
-- nothing here is referenced by User/Result, so this is safe to apply without downtime and
-- without affecting any existing feature.

-- CreateEnum
CREATE TYPE "SkillRelationType" AS ENUM ('PREREQUISITE_OF', 'RELATED_TO', 'ADVANCED_VERSION_OF', 'REQUIRED_BY', 'COMMONLY_CONFUSED_WITH');

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillRelation" (
    "id" TEXT NOT NULL,
    "fromSkillId" TEXT NOT NULL,
    "toSkillId" TEXT NOT NULL,
    "type" "SkillRelationType" NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillRelation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Skill_name_key" ON "Skill"("name");

-- CreateIndex
CREATE INDEX "Skill_category_idx" ON "Skill"("category");

-- CreateIndex
CREATE INDEX "SkillRelation_fromSkillId_idx" ON "SkillRelation"("fromSkillId");

-- CreateIndex
CREATE INDEX "SkillRelation_toSkillId_idx" ON "SkillRelation"("toSkillId");

-- CreateIndex
CREATE UNIQUE INDEX "SkillRelation_fromSkillId_toSkillId_type_key" ON "SkillRelation"("fromSkillId", "toSkillId", "type");

-- AddForeignKey
ALTER TABLE "SkillRelation" ADD CONSTRAINT "SkillRelation_fromSkillId_fkey" FOREIGN KEY ("fromSkillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillRelation" ADD CONSTRAINT "SkillRelation_toSkillId_fkey" FOREIGN KEY ("toSkillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
