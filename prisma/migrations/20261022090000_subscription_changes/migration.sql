-- CreateTable
CREATE TABLE "SubscriptionChange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT,
    "status" "SubscriptionStatus" NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3),
    "priceMonthly" DECIMAL(10,2),
    "currency" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubscriptionChange_tenantId_createdAt_idx" ON "SubscriptionChange"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "SubscriptionChange" ADD CONSTRAINT "SubscriptionChange_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionChange" ADD CONSTRAINT "SubscriptionChange_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing subscriptions start their history with today's state, dated when they were created.
-- Earlier changes were never recorded, so months before this migration are an approximation.
INSERT INTO "SubscriptionChange" ("id", "tenantId", "planId", "status", "currentPeriodEnd", "priceMonthly", "currency", "createdAt")
SELECT gen_random_uuid()::text, s."tenantId", s."planId", s."status", s."currentPeriodEnd", p."priceMonthly", p."currency", s."createdAt"
FROM "Subscription" s
JOIN "Plan" p ON p."id" = s."planId";
