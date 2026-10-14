-- One sign-in, many centers: a user's role, status and library allocation in each center move
-- from "User" to a "Membership" row. Every existing user with a center gets exactly one.

CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "statusReason" TEXT,
    "statusChangedAt" TIMESTAMP(3),
    "statusChangedById" TEXT,
    "storageQuotaMb" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

INSERT INTO "Membership" ("id", "userId", "tenantId", "role", "status", "statusReason", "statusChangedAt", "statusChangedById", "storageQuotaMb", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "id", "tenantId", "role", "status", "statusReason", "statusChangedAt", "statusChangedById", "storageQuotaMb", "createdAt", "updatedAt"
FROM "User"
WHERE "tenantId" IS NOT NULL;

CREATE INDEX "Membership_tenantId_role_idx" ON "Membership"("tenantId", "role");
CREATE UNIQUE INDEX "Membership_userId_tenantId_key" ON "Membership"("userId", "tenantId");
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The platform operator was a user without a center.
ALTER TABLE "User" ADD COLUMN "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "lastMembershipId" TEXT;
UPDATE "User" SET "isPlatformAdmin" = true WHERE "role" = 'SUPER_ADMIN';
UPDATE "User" u SET "lastMembershipId" = m."id" FROM "Membership" m WHERE m."userId" = u."id";

-- Teacher and student profiles hang off the membership; a user may now have one per center.
ALTER TABLE "Teacher" ADD COLUMN "membershipId" TEXT;
UPDATE "Teacher" t SET "membershipId" = m."id" FROM "Membership" m WHERE m."userId" = t."userId" AND m."tenantId" = t."tenantId";
ALTER TABLE "Teacher" ALTER COLUMN "membershipId" SET NOT NULL;
DROP INDEX "Teacher_userId_key";
CREATE UNIQUE INDEX "Teacher_membershipId_key" ON "Teacher"("membershipId");
CREATE UNIQUE INDEX "Teacher_userId_tenantId_key" ON "Teacher"("userId", "tenantId");
ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Student" ADD COLUMN "membershipId" TEXT;
UPDATE "Student" s SET "membershipId" = m."id" FROM "Membership" m WHERE m."userId" = s."userId" AND m."tenantId" = s."tenantId";
ALTER TABLE "Student" ALTER COLUMN "membershipId" SET NOT NULL;
DROP INDEX "Student_userId_key";
CREATE UNIQUE INDEX "Student_membershipId_key" ON "Student"("membershipId");
CREATE UNIQUE INDEX "Student_userId_tenantId_key" ON "Student"("userId", "tenantId");
ALTER TABLE "Student" ADD CONSTRAINT "Student_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Open sessions belong to the center they were signed into.
ALTER TABLE "RefreshToken" ADD COLUMN "membershipId" TEXT;
UPDATE "RefreshToken" r SET "membershipId" = u."lastMembershipId" FROM "User" u WHERE u."id" = r."userId";
CREATE INDEX "RefreshToken_membershipId_idx" ON "RefreshToken"("membershipId");
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Now the user is identity only.
ALTER TABLE "User" DROP CONSTRAINT "User_tenantId_fkey";
DROP INDEX "User_tenantId_idx";
ALTER TABLE "User" DROP COLUMN "role",
DROP COLUMN "status",
DROP COLUMN "statusChangedAt",
DROP COLUMN "statusChangedById",
DROP COLUMN "statusReason",
DROP COLUMN "storageQuotaMb",
DROP COLUMN "tenantId";
