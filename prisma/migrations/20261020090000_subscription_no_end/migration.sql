-- A package granted for good has no end date.
ALTER TABLE "Subscription" ALTER COLUMN "currentPeriodEnd" DROP NOT NULL;
