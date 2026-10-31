
-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "supportSessionId" TEXT;

-- CreateTable
CREATE TABLE "SupportSession" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "membershipId" TEXT,
    "targetName" TEXT NOT NULL,
    "targetEmail" TEXT NOT NULL,
    "targetRole" "Role" NOT NULL,
    "reason" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "SupportSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportAction" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportSession_tenantId_startedAt_idx" ON "SupportSession"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "SupportSession_actorId_idx" ON "SupportSession"("actorId");

-- CreateIndex
CREATE INDEX "SupportAction_sessionId_createdAt_idx" ON "SupportAction"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "RefreshToken_supportSessionId_idx" ON "RefreshToken"("supportSessionId");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_supportSessionId_fkey" FOREIGN KEY ("supportSessionId") REFERENCES "SupportSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAction" ADD CONSTRAINT "SupportAction_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SupportSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

