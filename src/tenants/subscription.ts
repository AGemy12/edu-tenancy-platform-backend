import type { SubscriptionStatus } from '../generated/prisma/enums.js';

type SubscriptionLike = { status: SubscriptionStatus; currentPeriodEnd: Date | null } | null | undefined;

/**
 * A center's subscription has lapsed once it is canceled or its paid (or trial) period is over.
 * Lapsed centers keep read access; every write is refused until the platform renews them.
 * A center without a subscription row has nothing to enforce; one without an end date never lapses.
 */
export function isExpired(sub: SubscriptionLike, now = new Date()) {
  if (!sub) return false;
  return sub.status === 'CANCELED' || (sub.currentPeriodEnd !== null && sub.currentPeriodEnd <= now);
}
