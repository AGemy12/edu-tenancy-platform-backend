import type { AttendanceStatus, SessionStatus } from '../generated/prisma/enums.js';
import { zonedTime } from '../schedules/schedule-plan.js';

/**
 * Report rules. Pure functions, so every report (screen and PDF) counts the same way and the
 * rules are unit-tested.
 *
 * What one student's seat on one session counts as:
 * - CANCELED and MISSED sessions are shown apart and never count against the student
 *   (MISSED means the teacher never started it: that is the teacher's record, not the student's).
 * - The teacher's evaluation decides: PRESENT, LATE, ABSENT, or EXCUSED (absent with leave).
 * - Before an evaluation, a student who joined counts as PRESENT.
 * - A completed session with neither is UNRECORDED: the teacher still owes the evaluation, so it
 *   isn't an absence.
 * - Scheduled and live sessions are UPCOMING.
 *
 * Attendance rate = (present + late) ÷ (present + late + absent). Excused, unrecorded,
 * upcoming, canceled and missed seats are left out of it.
 */

export type Outcome = 'PRESENT' | 'LATE' | 'ABSENT' | 'EXCUSED' | 'UNRECORDED' | 'UPCOMING' | 'CANCELED' | 'MISSED';

export const OUTCOMES: Outcome[] = ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED', 'UNRECORDED', 'UPCOMING', 'CANCELED', 'MISSED'];

/** Seats on sessions that took place (whatever the student did). */
export const HELD: Outcome[] = ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED', 'UNRECORDED'];

export function outcomeOf(
  session: { status: SessionStatus },
  seat: { attended: boolean; status: AttendanceStatus | null },
): Outcome {
  if (session.status === 'CANCELED') return 'CANCELED';
  if (session.status === 'MISSED') return 'MISSED';
  if (seat.status) return seat.status;
  if (seat.attended) return 'PRESENT';
  return session.status === 'COMPLETED' ? 'UNRECORDED' : 'UPCOMING';
}

export type Tally = Record<Outcome, number>;

export function tally(outcomes: Iterable<Outcome>): Tally {
  const t = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Tally;
  for (const o of outcomes) t[o] += 1;
  return t;
}

/** Seats counted in the attendance rate. */
export const counted = (t: Tally) => t.PRESENT + t.LATE + t.ABSENT;

export const held = (t: Tally) => HELD.reduce((n, o) => n + t[o], 0);

/** (present + late) ÷ (present + late + absent), 0..1; null when nothing counts yet. */
export function attendanceRate(t: Tally): number | null {
  const n = counted(t);
  return n ? (t.PRESENT + t.LATE) / n : null;
}

/** Of the times the student came, how often on time; null when they never came. */
export function punctualityRate(t: Tally): number | null {
  const came = t.PRESENT + t.LATE;
  return came ? t.PRESENT / came : null;
}

export function average(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

/** A score as a percentage of the exam's total marks. */
export const percentOf = (score: number, totalMarks: number) => (totalMarks > 0 ? (score / totalMarks) * 100 : 0);

/** Absences in a row at the end of `outcomes` (oldest first). Excused and unrecorded seats neither break nor extend it. */
export function trailingAbsences(outcomes: Outcome[]) {
  let n = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    const o = outcomes[i];
    if (o === 'ABSENT') n++;
    else if (o === 'PRESENT' || o === 'LATE') break;
  }
  return n;
}

/** The longest run of absences in `outcomes` (oldest first), skipping excused and unrecorded seats. */
export function longestAbsences(outcomes: Outcome[]) {
  let best = 0;
  let run = 0;
  for (const o of outcomes) {
    if (o === 'ABSENT') best = Math.max(best, ++run);
    else if (o === 'PRESENT' || o === 'LATE') run = 0;
  }
  return best;
}

/** One student's seat on one session, as reports read it. */
export type Seat = { outcome: Outcome; minutes: number; rating: number | null; at: Date };

/** Everything a report says about a set of seats: counts, rates, time, ratings and absence runs. */
export function summarizeSeats(seats: Seat[]) {
  const t = tally(seats.map((s) => s.outcome));
  const came = (o: Outcome) => o === 'PRESENT' || o === 'LATE';
  const chronological = [...seats].sort((a, b) => a.at.getTime() - b.at.getTime()).map((s) => s.outcome);
  const sumMinutes = (pick: (o: Outcome) => boolean) => seats.reduce((n, s) => n + (pick(s.outcome) ? s.minutes : 0), 0);
  return {
    counts: t,
    seats: seats.length,
    held: held(t),
    counted: counted(t),
    attendanceRate: attendanceRate(t),
    punctualityRate: punctualityRate(t),
    /** Booked time of the sessions that took place. */
    heldMinutes: sumMinutes((o) => HELD.includes(o)),
    /** Booked time of the sessions the student came to. */
    attendedMinutes: sumMinutes(came),
    averageRating: round1(average(seats.flatMap((s) => (s.rating !== null && came(s.outcome) ? [s.rating] : [])))),
    streak: trailingAbsences(chronological),
    longestStreak: longestAbsences(chronological),
  };
}

export type SeatSummary = ReturnType<typeof summarizeSeats>;

// ───────── Follow-up flags ─────────

export const RISK = {
  /** Below this attendance rate… */
  minAttendance: 0.75,
  /** …once at least this many seats count. */
  minCounted: 3,
  /** This many absences in a row, up to now. */
  absenceStreak: 3,
  /** Exam average below this percentage. */
  minExamPercent: 50,
  /** Mean session rating (1–10) below this. */
  minRating: 5,
} as const;

export type RiskFlag = 'LOW_ATTENDANCE' | 'ABSENCE_STREAK' | 'LOW_SCORES' | 'LOW_RATING';

export function riskFlags(s: { tally: Tally; streak: number; examAverage: number | null; averageRating: number | null }): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const rate = attendanceRate(s.tally);
  if (rate !== null && counted(s.tally) >= RISK.minCounted && rate < RISK.minAttendance) flags.push('LOW_ATTENDANCE');
  if (s.streak >= RISK.absenceStreak) flags.push('ABSENCE_STREAK');
  if (s.examAverage !== null && s.examAverage < RISK.minExamPercent) flags.push('LOW_SCORES');
  if (s.averageRating !== null && s.averageRating < RISK.minRating) flags.push('LOW_RATING');
  return flags;
}

// ───────── Teachers ─────────

/** A teacher who opens the meeting this many minutes after its start is still on time. */
export const ON_TIME_GRACE_MIN = 5;

/** Minutes between the planned start and the real one; null when the start wasn't recorded. */
export function startDelay(s: { startAt: Date; startedAt: Date | null }): number | null {
  if (!s.startedAt) return null;
  return Math.max(0, Math.round((s.startedAt.getTime() - s.startAt.getTime()) / 60_000));
}

/** A held session is evaluated once every student on it has an evaluation status. */
export const isEvaluated = (seats: { status: AttendanceStatus | null }[]) => seats.every((a) => a.status !== null);

// ───────── Exams ─────────

/** Grade bands for score distributions, lowest first: <50, 50–64, 65–74, 75–84, 85+. */
export const SCORE_BANDS = [0, 50, 65, 75, 85] as const;

export function scoreBand(percent: number) {
  let band = 0;
  SCORE_BANDS.forEach((min, i) => {
    if (percent >= min) band = i;
  });
  return band;
}

export function distribution(percents: number[]) {
  const out = SCORE_BANDS.map(() => 0);
  for (const p of percents) out[scoreBand(p)] += 1;
  return out;
}

// ───────── Periods (calendar days in the center's time zone) ─────────

/** One report covers at most this many days. */
export const MAX_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;
const toUtc = (day: string) => Date.parse(`${day}T00:00:00Z`);
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (day: string, n: number) => fromUtc(toUtc(day) + n * DAY_MS);

/** Days from `from` to `to`, both included. */
export const dayCount = (from: string, to: string) => Math.round((toUtc(to) - toUtc(from)) / DAY_MS) + 1;

/** The instants a period of days covers: [start of `from`, start of the day after `to`). */
export function periodBounds(from: string, to: string, timeZone: string) {
  return { start: zonedTime(from, '00:00', timeZone), end: zonedTime(addDays(to, 1), '00:00', timeZone) };
}

/** The period of the same length just before this one. */
export function previousPeriod(from: string, to: string) {
  const n = dayCount(from, to);
  return { from: addDays(from, -n), to: addDays(from, -1) };
}

/** "YYYY-MM-DD" of `d` in the center's time zone. */
export function dayKey(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Trend buckets over a period: days up to two weeks, weeks up to about a quarter, months beyond.
 * Each bucket is [from, to] in days, clipped to the period.
 */
export function buckets(from: string, to: string): { unit: 'day' | 'week' | 'month'; list: { from: string; to: string }[] } {
  const n = dayCount(from, to);
  const list: { from: string; to: string }[] = [];
  if (n <= 14) {
    for (let d = from; d <= to; d = addDays(d, 1)) list.push({ from: d, to: d });
    return { unit: 'day', list };
  }
  if (n <= 98) {
    for (let d = from; d <= to; d = addDays(d, 7)) {
      const end = addDays(d, 6);
      list.push({ from: d, to: end < to ? end : to });
    }
    return { unit: 'week', list };
  }
  let d = from;
  while (d <= to) {
    const [y, m] = d.split('-').map(Number);
    const next = fromUtc(Date.UTC(y, m, 1));
    const end = addDays(next, -1);
    list.push({ from: d, to: end < to ? end : to });
    d = next;
  }
  return { unit: 'month', list };
}

/** The first days of the months a period touches ("YYYY-MM-01"), for exams filed by month. */
export function monthStarts(from: string, to: string) {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  for (;;) {
    const first = fromUtc(Date.UTC(y, m - 1, 1));
    if (first > to) break;
    out.push(first);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
