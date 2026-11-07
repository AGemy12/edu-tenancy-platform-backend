-- Session pricing, simplified: prices are per session (never per hour), and the center sees four
-- things only: its default session price, each course's session price, a student's special price
-- in a course, and each teacher's pay per session. Older rate shapes are folded into these first.

-- 1. A student price narrowed to one teacher's sessions becomes the price of each of that teacher's courses.
INSERT INTO "BillingRate" ("id", "tenantId", "kind", "basis", "courseId", "amount", "effectiveFrom", "note", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, r."tenantId", r."kind", r."basis", c."id", r."amount", r."effectiveFrom", r."note", r."createdAt", CURRENT_TIMESTAMP
FROM "BillingRate" r
JOIN "Course" c ON c."teacherId" = r."teacherId"
WHERE r."kind" = 'STUDENT_FEE' AND r."teacherId" IS NOT NULL AND r."courseId" IS NULL AND r."studentId" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "BillingRate" x
    WHERE x."kind" = 'STUDENT_FEE' AND x."courseId" = c."id" AND x."studentId" IS NULL AND x."effectiveFrom" = r."effectiveFrom"
  );
DELETE FROM "BillingRate" WHERE "kind" = 'STUDENT_FEE' AND "teacherId" IS NOT NULL AND "courseId" IS NULL AND "studentId" IS NULL;

-- 2. A student's price for all their sessions becomes their special price in each course they're enrolled in.
INSERT INTO "BillingRate" ("id", "tenantId", "kind", "basis", "courseId", "studentId", "amount", "effectiveFrom", "note", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, r."tenantId", r."kind", r."basis", e."courseId", r."studentId", r."amount", r."effectiveFrom", r."note", r."createdAt", CURRENT_TIMESTAMP
FROM "BillingRate" r
JOIN "Enrollment" e ON e."studentId" = r."studentId"
WHERE r."kind" = 'STUDENT_FEE' AND r."studentId" IS NOT NULL AND r."courseId" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "BillingRate" x
    WHERE x."kind" = 'STUDENT_FEE' AND x."courseId" = e."courseId" AND x."studentId" = r."studentId" AND x."effectiveFrom" = r."effectiveFrom"
  );
DELETE FROM "BillingRate" WHERE "kind" = 'STUDENT_FEE' AND "studentId" IS NOT NULL AND "courseId" IS NULL;

-- 3. Student prices no longer name a teacher (a course already has one).
UPDATE "BillingRate" SET "teacherId" = NULL WHERE "kind" = 'STUDENT_FEE';

-- 4. Teacher pay is one value per teacher: a course-specific pay becomes the teacher's pay unless one starts the same day.
DELETE FROM "BillingRate" r
WHERE r."kind" = 'TEACHER_PAY' AND r."courseId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "BillingRate" x
    WHERE x."kind" = 'TEACHER_PAY' AND x."teacherId" = r."teacherId" AND x."courseId" IS NULL AND x."effectiveFrom" = r."effectiveFrom"
  );
UPDATE "BillingRate" SET "courseId" = NULL WHERE "kind" = 'TEACHER_PAY';

-- 5. Hourly amounts become the price of a session (sessions were one hour by default).
UPDATE "BillingRate" SET "basis" = 'PER_SESSION' WHERE "basis" = 'PER_HOUR';

-- AlterEnum
CREATE TYPE "RateBasis_new" AS ENUM ('PER_SESSION', 'PERCENT');
ALTER TABLE "BillingRate" ALTER COLUMN "basis" DROP DEFAULT;
ALTER TABLE "BillingRate" ALTER COLUMN "basis" TYPE "RateBasis_new" USING ("basis"::text::"RateBasis_new");
ALTER TYPE "RateBasis" RENAME TO "RateBasis_old";
ALTER TYPE "RateBasis_new" RENAME TO "RateBasis";
DROP TYPE "RateBasis_old";
ALTER TABLE "BillingRate" ALTER COLUMN "basis" SET DEFAULT 'PER_SESSION';

-- AlterTable
ALTER TABLE "BillingRate" ADD COLUMN "cleared" BOOLEAN NOT NULL DEFAULT false;

-- The course "price" was never used by billing: the course's session price lives on the rate card.
ALTER TABLE "Course" DROP COLUMN "price";

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN "platformFeePercent" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN "chargeAbsent" BOOLEAN NOT NULL DEFAULT true;

-- The open package: hidden from centers, granted by the platform as a trial or a gift.
INSERT INTO "Plan" ("id", "code", "nameAr", "nameEn", "descriptionAr", "descriptionEn", "priceMonthly", "isPublic", "sortOrder",
                    "maxTeachers", "maxStudents", "storagePerTeacherMb", "sharedStorageMb", "maxFileMb", "updatedAt")
VALUES (gen_random_uuid()::text, 'OPEN', 'المفتوحة', 'Open', 'تمنحها المنصة للتجربة أو هدية', 'Granted by the platform as a trial or a gift',
        0, false, 99, 1000, 100000, 10240, 51200, 500, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
