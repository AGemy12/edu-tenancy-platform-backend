-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ACTIVE', 'ENDED', 'MISSED');

-- AlterEnum
ALTER TYPE "MessageKind" ADD VALUE 'CALL';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "callId" TEXT;

-- CreateTable
CREATE TABLE "SessionCall" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
    "joinUrl" TEXT NOT NULL,
    "externalMeetingId" TEXT,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionCall_sessionId_createdAt_idx" ON "SessionCall"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "SessionCall_externalMeetingId_idx" ON "SessionCall"("externalMeetingId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_callId_key" ON "Message"("callId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_callId_fkey" FOREIGN KEY ("callId") REFERENCES "SessionCall"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionCall" ADD CONSTRAINT "SessionCall_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionCall" ADD CONSTRAINT "SessionCall_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionCall" ADD CONSTRAINT "SessionCall_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

