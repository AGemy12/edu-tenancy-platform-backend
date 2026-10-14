-- Sessions: a MISSED status, real start/end times, and no stored Zoom start link
-- (Zoom start links expire within hours, so the API now fetches a fresh one on demand).
ALTER TYPE "SessionStatus" ADD VALUE 'MISSED';

ALTER TABLE "Session" DROP COLUMN "hostUrl",
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "endedAt" TIMESTAMP(3);

-- Back-fill what we know for sessions that already ran.
UPDATE "Session" SET "startedAt" = "startAt" WHERE "status" IN ('LIVE', 'COMPLETED');
UPDATE "Session" SET "endedAt" = "endAt" WHERE "status" = 'COMPLETED';

CREATE INDEX "Session_status_endAt_idx" ON "Session"("status", "endAt");
CREATE INDEX "Session_externalMeetingId_idx" ON "Session"("externalMeetingId");

-- Integrations: the connected account's email (Zoom stores its user id in externalId).
ALTER TABLE "Integration" ADD COLUMN     "externalEmail" TEXT;
