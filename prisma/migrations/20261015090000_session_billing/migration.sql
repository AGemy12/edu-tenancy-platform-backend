-- CreateEnum
CREATE TYPE "RateKind" AS ENUM ('STUDENT_FEE', 'TEACHER_PAY');

-- CreateEnum
CREATE TYPE "RateBasis" AS ENUM ('PER_HOUR', 'PERCENT');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'EGP';

-- CreateTable
CREATE TABLE "BillingRate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "RateKind" NOT NULL,
    "basis" "RateBasis" NOT NULL DEFAULT 'PER_HOUR',
    "teacherId" TEXT NOT NULL,
    "courseId" TEXT,
    "studentId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingRate_tenantId_teacherId_kind_idx" ON "BillingRate"("tenantId", "teacherId", "kind");

-- AddForeignKey
ALTER TABLE "BillingRate" ADD CONSTRAINT "BillingRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingRate" ADD CONSTRAINT "BillingRate_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingRate" ADD CONSTRAINT "BillingRate_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingRate" ADD CONSTRAINT "BillingRate_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

