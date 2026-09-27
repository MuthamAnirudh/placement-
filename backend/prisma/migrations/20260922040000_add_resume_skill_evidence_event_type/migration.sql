-- Extends LearningEvent to accept Resume/JD Explainable Competency Matching results, so the
-- Digital Twin has a third real writer alongside sync-adaptive-report (quiz/coding) and
-- sync-interview-session (mock interview rubric) — see digitalTwinRepo.syncResumeMatch().
-- Purely additive — no existing table, column, or row is touched.

-- AlterEnum
ALTER TYPE "LearningEventType" ADD VALUE 'RESUME_SKILL_EVIDENCE';
