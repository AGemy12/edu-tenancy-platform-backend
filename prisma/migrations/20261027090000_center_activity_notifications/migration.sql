-- AlterEnum
ALTER TYPE "NotificationCategory" ADD VALUE 'ACTIVITY';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'MEMBER_ADDED';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "oversight" BOOLEAN NOT NULL DEFAULT false;

