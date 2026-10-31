/** Timing rules of the scheduled notices (pure, unit-tested). */

/** "Starting soon" goes out this many minutes before a session. */
export const REMINDER_LEAD_MIN = 15;
/** Admins hear this many days before the subscription period ends. */
export const SUBSCRIPTION_NOTICE_DAYS = 3;
/** A period that ended longer ago than this gets no "expired" notice (it was dealt with, or is old news). */
export const EXPIRED_NOTICE_DAYS = 7;
/** Notifications older than this are deleted. */
export const RETENTION_DAYS = 180;

const DAY = 24 * 60 * 60_000;

/**
 * The notice a subscription ending at `end` calls for now, if any. `key` identifies it: the same
 * notice for the same period end is sent once, and a renewal (new end) starts over.
 */
export function subscriptionNotice(end: Date, now: Date): { kind: 'EXPIRING' | 'EXPIRED'; key: string } | null {
  const left = end.getTime() - now.getTime();
  if (left > SUBSCRIPTION_NOTICE_DAYS * DAY) return null;
  if (left > 0) return { kind: 'EXPIRING', key: `EXPIRING:${end.toISOString()}` };
  if (-left > EXPIRED_NOTICE_DAYS * DAY) return null;
  return { kind: 'EXPIRED', key: `EXPIRED:${end.toISOString()}` };
}
