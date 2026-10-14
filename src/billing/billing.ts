import type { RateBasis, RateKind, SessionStatus } from '../generated/prisma/enums.js';

/**
 * Session billing rules. Pure functions, so they're unit-tested and shared by every report.
 *
 * - A session is charged once the teacher has entered it: LIVE, or COMPLETED (the host started
 *   it, the provider reported it, or the teacher confirmed it was held). CANCELED (an emergency
 *   on either side) and MISSED (the teacher never came) cost nothing.
 * - Every student on a charged session pays for its booked time (`startAt` → `endAt`), whether
 *   or not they joined: the teacher kept the slot for them.
 * - Prices come from the rate card: the most specific rate in effect at the session's start.
 * - Money is summed in whole cents so totals never drift.
 */

export const BILLABLE_STATUSES: SessionStatus[] = ['LIVE', 'COMPLETED'];

export const isBillable = (status: SessionStatus) => BILLABLE_STATUSES.includes(status);

/** The booked length of a session, in whole minutes. */
export function bookedMinutes(s: { startAt: Date; endAt: Date }) {
  return Math.max(0, Math.round((s.endAt.getTime() - s.startAt.getTime()) / 60_000));
}

/** How long the meeting really ran, when both ends were recorded. */
export function actualMinutes(s: { startedAt: Date | null; endedAt: Date | null }) {
  if (!s.startedAt || !s.endedAt) return null;
  return Math.max(0, Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 60_000));
}

export type Rate = {
  id: string;
  kind: RateKind;
  basis: RateBasis;
  teacherId: string;
  courseId: string | null;
  studentId: string | null;
  amount: number;
  effectiveFrom: Date;
};

export type RateSource = 'STUDENT' | 'COURSE' | 'TEACHER';

export const rateSource = (r: Pick<Rate, 'courseId' | 'studentId'>): RateSource =>
  r.studentId ? 'STUDENT' : r.courseId ? 'COURSE' : 'TEACHER';

/** A student match outranks a course match, which outranks the teacher's default. */
const specificity = (r: Rate) => (r.studentId ? 2 : 0) + (r.courseId ? 1 : 0);

/**
 * The rate that prices `target`: among rates in effect at `at` whose every set field matches,
 * the most specific one, then the most recent.
 */
export function resolveRate(
  rates: Rate[],
  target: { kind: RateKind; teacherId: string; courseId: string | null; studentId?: string | null; at: Date },
): Rate | null {
  let best: Rate | null = null;
  for (const r of rates) {
    if (r.kind !== target.kind || r.teacherId !== target.teacherId) continue;
    if (r.courseId && r.courseId !== target.courseId) continue;
    if (r.studentId && r.studentId !== (target.studentId ?? null)) continue;
    if (r.effectiveFrom.getTime() > target.at.getTime()) continue;
    if (
      !best ||
      specificity(r) > specificity(best) ||
      (specificity(r) === specificity(best) && r.effectiveFrom.getTime() > best.effectiveFrom.getTime())
    ) {
      best = r;
    }
  }
  return best;
}

export type RateStatus = 'ACTIVE' | 'SCHEDULED' | 'SUPERSEDED';

/**
 * Where each rate stands at `now` among the rates for the same price (kind, teacher, course,
 * student): the latest one already in effect is ACTIVE, earlier ones are SUPERSEDED, and ones
 * that start later are SCHEDULED.
 */
export function rateStatuses(rates: Rate[], now: Date): Map<string, RateStatus> {
  const scopes = new Map<string, Rate[]>();
  for (const r of rates) {
    const key = [r.kind, r.teacherId, r.courseId ?? '', r.studentId ?? ''].join('|');
    scopes.set(key, [...(scopes.get(key) ?? []), r]);
  }
  const out = new Map<string, RateStatus>();
  for (const group of scopes.values()) {
    const started = group.filter((r) => r.effectiveFrom.getTime() <= now.getTime());
    const current = started.reduce<Rate | null>(
      (best, r) => (!best || r.effectiveFrom.getTime() > best.effectiveFrom.getTime() ? r : best),
      null,
    );
    for (const r of group) {
      out.set(r.id, r.effectiveFrom.getTime() > now.getTime() ? 'SCHEDULED' : r === current ? 'ACTIVE' : 'SUPERSEDED');
    }
  }
  return out;
}

export const toCents =(amount: number) => Math.round(amount * 100);
export const fromCents = (cents: number) => cents / 100;

/** What `minutes` cost at `perHour`, in cents. */
export function chargeCents(perHour: number, minutes: number) {
  return Math.round((toCents(perHour) * minutes) / 60);
}

/** The teacher's pay for one session: per hour taught, or a share of its students' fees. */
export function teacherPayCents(rate: Pick<Rate, 'basis' | 'amount'>, minutes: number, feesCents: number) {
  return rate.basis === 'PERCENT' ? Math.round((feesCents * rate.amount) / 100) : chargeCents(rate.amount, minutes);
}

/** "YYYY-MM" of `d` in the center's time zone (a 1am session on the 1st belongs to that month). */
export function monthKey(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}
