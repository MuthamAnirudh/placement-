CREATE TABLE "PasswordRecovery" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "verifiedAt" TIMESTAMP(3),
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordRecovery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PasswordRecovery_tokenHash_key" UNIQUE ("tokenHash"),
  CONSTRAINT "PasswordRecovery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PasswordRecovery_userId_idx" ON "PasswordRecovery"("userId");
CREATE INDEX "PasswordRecovery_expiresAt_idx" ON "PasswordRecovery"("expiresAt");
