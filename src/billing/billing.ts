import type { AttendanceStatus, RateBasis, RateKind, SessionStatus } from '../generated/prisma/enums.js';

/**
 * Session billing rules. Pure functions, so they're unit-tested and shared by every report.
 *
 * - Prices are per session, never per hour: a session costs the same whatever its length.
 * - A session is charged once the teacher has entered it: LIVE, or COMPLETED (the host started
 *   it, the provider reported it, or the teacher confirmed it was held). CANCELED (an emergency
 *   on either side) and MISSED (the teacher never came) cost nothing.
 * - Each student on a charged session pays its price unless excused; one absent without an
 *   excuse pays too when the center says so (`Tenant.chargeAbsent`, the default): the teacher
 *   kept the slot for them. Before the teacher evaluates the session, everyone on it pays.
 * - The price: the student's special price in the course, else the course's price, else the
 *   center's default price, each the one in effect when the session started.
 * - The teacher's pay: a fixed amount for the whole session, or a share of what its students
 *   paid. A fixed pay is owed unless every student was excused.
 * - Money flows student → center → teacher, and center → platform:
 *     center net = student fees − teacher pay − platform fee.
 *   The platform's fee is a share of the session's fees: the center's own percentage, else its
 *   package's.
 * - Money is summed in whole cents so totals never drift.
 */

export const BILLABLE_STATUSES: SessionStatus[] = ['LIVE', 'COMPLETED'];

export const isBillable = (status: SessionStatus) => BILLABLE_STATUSES.includes(status);

/** The booked length of a session, in whole minutes (shown as teaching time; it doesn't change the price). */
export function bookedMinutes(s: { startAt: Date; endAt: Date }) {
  return Math.max(0, Math.round((s.endAt.getTime() - s.startAt.getTime()) / 60_000));
}

/** How long the meeting really ran, when both ends were recorded. */
export function actualMinutes(s: { startedAt: Date | null; endedAt: Date | null }) {
  if (!s.startedAt || !s.endedAt) return null;
  return Math.max(0, Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 60_000));
}

/** Why a student on a charged session pays nothing. */
export type FreeReason = 'EXCUSED' | 'ABSENT';

/** Whether a student pays for a charged session, given the teacher's evaluation (null = not yet). */
export function chargeOf(status: AttendanceStatus | null, chargeAbsent: boolean): { charged: true } | { charged: false; reason: FreeReason } {
  if (status === 'EXCUSED') return { charged: false, reason: 'EXCUSED' };
  if (status === 'ABSENT' && !chargeAbsent) return { charged: false, reason: 'ABSENT' };
  return { charged: true };
}

export type Rate = {
  id: string;
  kind: RateKind;
  basis: RateBasis;
  /** TEACHER_PAY only. */
  teacherId: string | null;
  courseId: string | null;
  /** STUDENT_FEE with a course only: a special price. */
  studentId: string | null;
  amount: number;
  /** The price ends here: the scope stops applying from `effectiveFrom`. */
  cleared: boolean;
  effectiveFrom: Date;
};

/** Where a price came from: a special price, the course's, the center's default, or the teacher's pay. */
export type RateSource = 'STUDENT' | 'COURSE' | 'CENTER' | 'TEACHER';

export const rateSource = (r: Pick<Rate, 'teacherId' | 'courseId' | 'studentId'>): RateSource =>
  r.studentId ? 'STUDENT' : r.courseId ? 'COURSE' : r.teacherId ? 'TEACHER' : 'CENTER';

/** The rows of one price share a scope; its latest row in effect is its value. */
export const scopeKey = (r: Pick<Rate, 'kind' | 'teacherId' | 'courseId' | 'studentId'>) =>
  [r.kind, r.teacherId ?? '', r.courseId ?? '', r.studentId ?? ''].join('|');

/** A special price outranks the course's, which outranks the center's default. */
const specificity = (r: Rate) => (r.studentId ? 4 : 0) + (r.courseId ? 2 : 0) + (r.teacherId ? 1 : 0);

/** The latest row of each scope in effect at `at`. */
function latestByScope(rates: Rate[], at: Date) {
  const latest = new Map<string, Rate>();
  for (const r of rates) {
    if (r.effectiveFrom.getTime() > at.getTime()) continue;
    const key = scopeKey(r);
    const prev = latest.get(key);
    if (!prev || r.effectiveFrom.getTime() > prev.effectiveFrom.getTime()) latest.set(key, r);
  }
  return latest;
}

/**
 * The rate that prices `target`: each scope that matches it contributes its value at `at` (a
 * cleared one contributes nothing), and the most specific wins.
 */
export function resolveRate(
  rates: Rate[],
  target: { kind: RateKind; teacherId: string; courseId: string | null; studentId?: string | null; at: Date },
): Rate | null {
  const matching = rates.filter(
    (r) =>
      r.kind === target.kind &&
      (!r.teacherId || r.teacherId === target.teacherId) &&
      (!r.courseId || r.courseId === target.courseId) &&
      (!r.studentId || r.studentId === (target.studentId ?? null)),
  );
  let best: Rate | null = null;
  for (const r of latestByScope(matching, target.at).values()) {
    if (r.cleared) continue;
    if (!best || specificity(r) > specificity(best)) best = r;
  }
  return best;
}

/** The value of each scope at `at`: what the center sees as "the price" today. Cleared scopes are left out. */
export function currentRates(rates: Rate[], at: Date) {
  return [...latestByScope(rates, at).values()].filter((r) => !r.cleared);
}

export const toCents = (amount: number) => Math.round(amount * 100);
export const fromCents = (cents: number) => cents / 100;

/** A student's fee for one session. */
export const studentFeeCents = (rate: Pick<Rate, 'amount'>) => toCents(rate.amount);

/** The teacher's pay for one session: a fixed amount, or a share of its students' fees. */
export function teacherPayCents(rate: Pick<Rate, 'basis' | 'amount'>, feesCents: number) {
  return rate.basis === 'PERCENT' ? Math.round((feesCents * rate.amount) / 100) : toCents(rate.amount);
}

/** A fixed pay is owed unless every student on the session was excused (an empty session still pays). */
export const teacherIsPaid = (statuses: (AttendanceStatus | null)[]) => statuses.length === 0 || statuses.some((s) => s !== 'EXCUSED');

/** The platform's percentage on a center: its own, else its package's; null = none. */
export function effectivePlatformFee(centerPercent: number | null, packagePercent: number | null) {
  const p = centerPercent ?? packagePercent;
  return p ? p : null;
}

/** The platform's cut of a session's student fees; nothing when no fee is set. */
export function platformFeeCents(feesCents: number, percent: number | null) {
  return percent ? Math.round((feesCents * percent) / 100) : 0;
}

/** Student fees of a whole session (every charged attendee), used where names aren't needed. */
export function sessionFeesCents(
  s: {
    status: SessionStatus;
    startAt: Date;
    teacherId: string;
    courseId: string | null;
    attendees: { studentId: string; status: AttendanceStatus | null }[];
  },
  rates: Rate[],
  chargeAbsent: boolean,
) {
  if (!isBillable(s.status)) return 0;
  let total = 0;
  for (const a of s.attendees) {
    if (!chargeOf(a.status, chargeAbsent).charged) continue;
    const rate = resolveRate(rates, { kind: 'STUDENT_FEE', teacherId: s.teacherId, courseId: s.courseId, studentId: a.studentId, at: s.startAt });
    if (rate) total += studentFeeCents(rate);
  }
  return total;
}

/** "YYYY-MM" of `d` in the center's time zone (a 1am session on the 1st belongs to that month). */
export function monthKey(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}
