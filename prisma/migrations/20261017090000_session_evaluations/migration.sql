-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT');

-- AlterTable
ALTER TABLE "SessionAttendee" ADD COLUMN     "comment" TEXT,
ADD COLUMN     "evaluatedAt" TIMESTAMP(3),
ADD COLUMN     "homework" TEXT,
ADD COLUMN     "progress" TEXT,
ADD COLUMN     "rating" INTEGER,
ADD COLUMN     "status" "AttendanceStatus";

