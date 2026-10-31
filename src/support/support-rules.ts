import type { SupportRequestStatus } from '../generated/prisma/enums.js';

/**
 * Support access is the center's call: the platform asks, the center's admin approves for a
 * while (or denies), and support enters only inside an approved window. Pure rules, unit-tested.
 */

/** A request nobody answered lapses after this long. */
export const PENDING_HOURS = 72;
/** How long an approval may keep access open, as the center's admin picks it. */
export const ACCESS_HOURS = [1, 4, 24, 72] as const;
/** Support session lengths the platform may ask for. */
export const SESSION_MINUTES = { min: 15, max: 240, default: 60 } as const;

const HOUR_MS = 60 * 60 * 1000;

export type RequestState = SupportRequestStatus | 'EXPIRED';
type RequestLike = { status: SupportRequestStatus; createdAt: Date; accessUntil: Date | null };

/** Where a request stands now: an unanswered one or an approval past its window has EXPIRED. */
export function requestState(r: RequestLike, now = new Date()): RequestState {
  if (r.status === 'PENDING' && r.createdAt.getTime() + PENDING_HOURS * HOUR_MS <= now.getTime()) return 'EXPIRED';
  if (r.status === 'APPROVED' && (!r.accessUntil || r.accessUntil <= now)) return 'EXPIRED';
  return r.status;
}

/** When the end of approved access falls. */
export const accessUntil = (hours: number, now = new Date()) => new Date(now.getTime() + hours * HOUR_MS);

/** A session lasts the requested minutes, never past the approved window. */
export function sessionEnd(r: { minutes: number; accessUntil: Date }, now = new Date()) {
  return new Date(Math.min(now.getTime() + r.minutes * 60_000, r.accessUntil.getTime()));
}
