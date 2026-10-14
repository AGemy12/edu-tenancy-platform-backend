-- Packages catalog, per-user storage quotas, shared (center) library and blob accounting.
-- Hand-written so existing subscriptions and library files are migrated, not dropped.

-- ───────── Enums ─────────
CREATE TYPE "LibraryScope" AS ENUM ('PERSONAL', 'SHARED');
CREATE TYPE "AddOnSource" AS ENUM ('PURCHASE', 'GRANT');

-- ───────── Plans (package catalog) ─────────
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "descriptionAr" TEXT,
    "descriptionEn" TEXT,
    "priceMonthly" DECIMAL(10,2),
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "maxTeachers" INTEGER NOT NULL,
    "maxStudents" INTEGER NOT NULL,
    "storagePerTeacherMb" INTEGER NOT NULL,
    "sharedStorageMb" INTEGER NOT NULL,
    "maxFileMb" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- Starter catalog; prices and limits are data and can be changed later.
INSERT INTO "Plan" ("id", "code", "nameAr", "nameEn", "descriptionAr", "descriptionEn", "priceMonthly", "sortOrder",
                    "maxTeachers", "maxStudents", "storagePerTeacherMb", "sharedStorageMb", "maxFileMb", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'FREE',  'المجانية',   'Free',  'للتجربة ومدرس واحد',              'To try it out with one teacher',      0,    1, 1,  30,   1024,  512,   25,  CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'BASIC', 'الأساسية',   'Basic', 'للمدرس المستقل والمراكز الصغيرة', 'For solo teachers and small centers', 499,  2, 5,  200,  5120,  5120,  100, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'PRO',   'الاحترافية', 'Pro',   'للمراكز الكبيرة',                 'For larger centers',                  1499, 3, 50, 2000, 20480, 51200, 500, CURRENT_TIMESTAMP);

-- ───────── Subscription → Plan ─────────
ALTER TABLE "Subscription" ADD COLUMN "planId" TEXT;
UPDATE "Subscription" s SET "planId" = p."id" FROM "Plan" p WHERE p."code" = s."plan"::text;
ALTER TABLE "Subscription" ALTER COLUMN "planId" SET NOT NULL;
ALTER TABLE "Subscription" DROP COLUMN "plan", DROP COLUMN "maxTeachers", DROP COLUMN "maxStudents", DROP COLUMN "maxStorageMb";
DROP TYPE "PlanTier";
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Quotas & permissions ─────────
ALTER TABLE "User" ADD COLUMN "storageQuotaMb" INTEGER;
ALTER TABLE "Teacher" ADD COLUMN "canManageSharedLibrary" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "StorageAddOn" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "extraMb" INTEGER NOT NULL,
    "source" "AddOnSource" NOT NULL,
    "note" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StorageAddOn_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StorageAddOn_tenantId_userId_idx" ON "StorageAddOn"("tenantId", "userId");
ALTER TABLE "StorageAddOn" ADD CONSTRAINT "StorageAddOn_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StorageAddOn" ADD CONSTRAINT "StorageAddOn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────── Blobs: one row per stored object, charged to one quota ─────────
CREATE TABLE "StoredBlob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "thumbnailKey" TEXT,
    "size" INTEGER NOT NULL,
    "chargedToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoredBlob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StoredBlob_key_key" ON "StoredBlob"("key");
CREATE INDEX "StoredBlob_tenantId_chargedToId_idx" ON "StoredBlob"("tenantId", "chargedToId");

-- Existing files: one blob per distinct storage key, charged to the owner of its oldest row.
INSERT INTO "StoredBlob" ("id", "tenantId", "key", "thumbnailKey", "size", "chargedToId", "createdAt")
SELECT gen_random_uuid()::text, f."tenantId", f."storageKey", f."thumbnailKey", f."size", f."ownerId", f."createdAt"
FROM (SELECT DISTINCT ON ("storageKey") * FROM "LibraryFile" ORDER BY "storageKey", "createdAt") f;

ALTER TABLE "LibraryFile" ADD COLUMN "blobId" TEXT;
UPDATE "LibraryFile" l SET "blobId" = b."id" FROM "StoredBlob" b WHERE b."key" = l."storageKey";
ALTER TABLE "LibraryFile" ALTER COLUMN "blobId" SET NOT NULL;
DROP INDEX "LibraryFile_storageKey_idx";
ALTER TABLE "LibraryFile" DROP COLUMN "storageKey", DROP COLUMN "thumbnailKey";

-- ───────── Scopes ─────────
ALTER TABLE "LibraryFile" ADD COLUMN "scope" "LibraryScope" NOT NULL DEFAULT 'PERSONAL';
ALTER TABLE "LibraryFolder" ADD COLUMN "scope" "LibraryScope" NOT NULL DEFAULT 'PERSONAL';
DROP INDEX "LibraryFile_tenantId_idx";
DROP INDEX "LibraryFolder_tenantId_idx";
CREATE INDEX "LibraryFile_tenantId_scope_idx" ON "LibraryFile"("tenantId", "scope");
CREATE INDEX "LibraryFile_blobId_idx" ON "LibraryFile"("blobId");
CREATE INDEX "LibraryFolder_tenantId_scope_idx" ON "LibraryFolder"("tenantId", "scope");

-- NO ACTION (checked at statement end) so tenant deletes can cascade to files and blobs together.
ALTER TABLE "LibraryFile" ADD CONSTRAINT "LibraryFile_blobId_fkey" FOREIGN KEY ("blobId") REFERENCES "StoredBlob"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "StoredBlob" ADD CONSTRAINT "StoredBlob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoredBlob" ADD CONSTRAINT "StoredBlob_chargedToId_fkey" FOREIGN KEY ("chargedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
