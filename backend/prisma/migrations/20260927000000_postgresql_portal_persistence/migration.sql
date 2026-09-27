-- Complete external hosted backend removal: move portal persistence behind Express/Prisma/PostgreSQL.
-- Additive migration only. It does not drop or truncate existing data.

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'COORDINATOR';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'TEACHER';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'MENTOR';

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "year" TEXT,
  ADD COLUMN IF NOT EXISTS "photo" TEXT,
  ADD COLUMN IF NOT EXISTS "recoveryEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "faceDescriptor" JSONB,
  ADD COLUMN IF NOT EXISTS "fingerprintCredentialId" TEXT,
  ADD COLUMN IF NOT EXISTS "classTeacherEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "mentorEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "legacySalt" TEXT;

CREATE TABLE IF NOT EXISTS "PortalKV" (
  "id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL DEFAULT 'PUBLIC',
  "value" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PortalKV_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PortalKV_scope_key_ownerId_key" ON "PortalKV"("scope","key","ownerId");
CREATE INDEX IF NOT EXISTS "PortalKV_scope_ownerId_idx" ON "PortalKV"("scope","ownerId");
CREATE INDEX IF NOT EXISTS "PortalKV_scope_key_idx" ON "PortalKV"("scope","key");

CREATE TABLE IF NOT EXISTS "CampusRecord" (
  "id" TEXT NOT NULL,
  "tableName" TEXT NOT NULL,
  "recordKey" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampusRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CampusRecord_tableName_recordKey_key" ON "CampusRecord"("tableName","recordKey");
CREATE INDEX IF NOT EXISTS "CampusRecord_tableName_idx" ON "CampusRecord"("tableName");

CREATE TABLE IF NOT EXISTS "GatePass" (
  "id" BIGINT NOT NULL,
  "status" TEXT NOT NULL,
  "studentEmail" TEXT,
  "qrToken" TEXT,
  "qrUsed" BOOLEAN NOT NULL DEFAULT false,
  "qrUsedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "data" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GatePass_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "GatePass_qrToken_key" ON "GatePass"("qrToken");
CREATE INDEX IF NOT EXISTS "GatePass_status_idx" ON "GatePass"("status");
CREATE INDEX IF NOT EXISTS "GatePass_studentEmail_idx" ON "GatePass"("studentEmail");
CREATE INDEX IF NOT EXISTS "GatePass_qrUsed_idx" ON "GatePass"("qrUsed");

-- Atomic gate-pass redemption primitive. The Express endpoint uses the same WHERE clause
-- through Prisma's transaction/conditional UPDATE; this SQL is useful for DBA inspection
-- or direct maintenance and has no dependency on any external platform.
CREATE OR REPLACE FUNCTION redeem_gate_pass_atomic(p_id BIGINT, p_token TEXT)
RETURNS TABLE(status TEXT, id BIGINT, qr_used BOOLEAN, qr_used_at TIMESTAMP(3))
LANGUAGE SQL
AS $$
  UPDATE "GatePass"
     SET "qrUsed" = TRUE, "qrUsedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = p_id
     AND "qrToken" = p_token
     AND "status" = 'approved'
     AND "qrUsed" = FALSE
     AND ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)
  RETURNING 'ok'::TEXT, "id", "qrUsed", "qrUsedAt";
$$;
