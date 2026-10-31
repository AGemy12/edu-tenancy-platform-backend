import type { Prisma } from '../generated/prisma/client.js';

/**
 * Appends the center's subscription, as it is now, to its history (`SubscriptionChange`).
 * Call it inside the transaction that changed the subscription, after the change.
 */
export async function recordSubscriptionChange(tx: Prisma.TransactionClient, tenantId: string, actorId: string | null = null) {
  const sub = await tx.subscription.findUnique({
    where: { tenantId },
    select: { planId: true, status: true, currentPeriodEnd: true, plan: { select: { priceMonthly: true, currency: true } } },
  });
  if (!sub) return;
  await tx.subscriptionChange.create({
    data: {
      tenantId,
      planId: sub.planId,
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      priceMonthly: sub.plan.priceMonthly,
      currency: sub.plan.currency,
      actorId,
    },
  });
}
