-- AlterEnum
ALTER TYPE "AttendanceStatus" ADD VALUE 'EXCUSED';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "logoKey" TEXT;
