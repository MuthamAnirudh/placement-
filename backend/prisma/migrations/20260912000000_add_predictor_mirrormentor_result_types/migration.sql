-- Extends ResultType so the AI Placement Predictor and MirrorMentor-X tabs can persist
-- results and use peer benchmarking exactly like Quiz/Interview/Roadmap/Radar/Resume
-- Analysis already do. Additive only — no existing rows or columns are touched.
ALTER TYPE "ResultType" ADD VALUE IF NOT EXISTS 'PLACEMENT_PREDICTION';
ALTER TYPE "ResultType" ADD VALUE IF NOT EXISTS 'MIRROR_MENTOR';
