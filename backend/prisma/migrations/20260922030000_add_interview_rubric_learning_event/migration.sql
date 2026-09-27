-- Extends LearningEvent to accept AI Mock Interviewer rubric results, so the Digital Twin
-- has a second real writer besides the adaptive-engine sync (see schema.prisma comment on
-- StudentCompetency for why each writer gets its own reviewed sync path instead of ad-hoc
-- writes). Purely additive — no existing table, column, or row is touched.

-- AlterEnum
ALTER TYPE "LearningEventType" ADD VALUE 'INTERVIEW_RUBRIC';
