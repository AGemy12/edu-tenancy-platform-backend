-- Student prices become the center's price list (no teacher required), rates can be flat per
-- session, and the platform can take a commission per center.

-- AlterEnum
ALTER TYPE "RateBasis" ADD VALUE 'PER_SESSION';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "platformFeePercent" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "BillingRate" ALTER COLUMN "teacherId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "BillingRate_tenantId_kind_idx" ON "BillingRate"("tenantId", "kind");
