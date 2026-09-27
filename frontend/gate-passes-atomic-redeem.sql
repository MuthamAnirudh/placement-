-- PostgreSQL gate-pass atomic redemption.
-- external hosted backend is no longer used. The production application calls
-- POST /api/gate-passes/public/redeem, which executes the same conditional update
-- through Prisma inside a PostgreSQL transaction.
--
-- This file is retained as an optional DBA/reference SQL script. Apply the Prisma
-- migration first.

CREATE OR REPLACE FUNCTION redeem_gate_pass_atomic(p_id BIGINT, p_token TEXT)
RETURNS TABLE(status TEXT, id BIGINT, qr_used BOOLEAN, qr_used_at TIMESTAMP(3))
LANGUAGE SQL
AS $$
  UPDATE "GatePass"
     SET "qrUsed" = TRUE,
         "qrUsedAt" = CURRENT_TIMESTAMP,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = p_id
     AND "qrToken" = p_token
     AND "status" = 'approved'
     AND "qrUsed" = FALSE
     AND ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)
  RETURNING 'ok'::TEXT, "id", "qrUsed", "qrUsedAt";
$$;
