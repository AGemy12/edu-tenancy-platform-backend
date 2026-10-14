-- Account status replaces the on/off flag: ACTIVE, SUSPENDED (read-only) or BLOCKED (no sign-in).
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'BLOCKED');

ALTER TABLE "User"
  ADD COLUMN "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "statusReason" TEXT,
  ADD COLUMN "statusChangedAt" TIMESTAMP(3),
  ADD COLUMN "statusChangedById" TEXT;

-- A deactivated account could not sign in, which is what BLOCKED means now.
UPDATE "User" SET "status" = 'BLOCKED', "statusChangedAt" = "updatedAt" WHERE "isActive" = false;

ALTER TABLE "User" DROP COLUMN "isActive";
