import type { MessageKey } from '../i18n/messages.js';

/**
 * Monthly schedules: a student buys `monthlyMinutes` with a teacher and is taught
 * `weeklyMinutes` a week, split evenly over the weekly slots (day + start time in the
 * tenant's timezone). The period runs one month from `startDate`; sessions are laid out
 * slot by slot until the monthly hours are used up (the last one may be shorter).
 */
export type Slot = { weekday: number; startTime: string };
export type Occurrence = { startAt: Date; endAt: Date };

/** Shorter sessions than this aren't generated (also the smallest leftover worth scheduling). */
export const MIN_SESSION_MIN = 15;
/** Upper bound on the sessions one schedule may generate. */
export const MAX_SESSIONS = 100;

const DAY_MS = 86_400_000;
const WEEK_MIN = 7 * 24 * 60;

export type PlanProblem = { key: MessageKey; params?: Record<string, string | number> };

/** Every session of a schedule lasts this long (weekly hours split over the slots). */
export const sessionLength = (weeklyMinutes: number, slotCount: number) => weeklyMinutes / slotCount;

/** Checks the hours and slots before anything is generated; null when they make sense. */
export function planProblem(p: { monthlyMinutes: number; weeklyMinutes: number; slots: Slot[] }): PlanProblem | null {
  if (p.weeklyMinutes > p.monthlyMinutes) return { key: 'schedules.weeklyAboveMonthly' };
  const length = sessionLength(p.weeklyMinutes, p.slots.length);
  if (!Number.isInteger(length) || length < MIN_SESSION_MIN) {
    return { key: 'schedules.sessionTooShort', params: { min: MIN_SESSION_MIN } };
  }
  // Slots as minutes into the week, sorted; each must end before the next starts (wrapping Saturday → Sunday).
  const starts = p.slots.map((s) => s.weekday * 24 * 60 + minutesOf(s.startTime)).sort((a, b) => a - b);
  if (new Set(starts).size !== starts.length) return { key: 'schedules.duplicateSlot' };
  for (let i = 0; i < starts.length; i++) {
    const next = i + 1 < starts.length ? starts[i + 1] : starts[0] + WEEK_MIN;
    if (starts.length > 1 && next - starts[i] < length) return { key: 'schedules.slotsOverlap' };
  }
  return null;
}

/** The exclusive end of a period: the same day next month, or the 1st after it when that day doesn't exist. */
export function periodEnd(startDate: string): string {
  const [y, m, d] = startDate.split('-').map(Number);
  const daysInNext = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const end = d <= daysInNext ? Date.UTC(y, m, d) : Date.UTC(y, m + 1, 1);
  return new Date(end).toISOString().slice(0, 10);
}

/** Lays out the period's sessions in time order, skipping slots that are already in the past. */
export function planSessions(p: {
  startDate: string;
  endDate: string;
  slots: Slot[];
  weeklyMinutes: number;
  monthlyMinutes: number;
  timeZone: string;
  now?: Date;
}): Occurrence[] {
  const length = sessionLength(p.weeklyMinutes, p.slots.length);
  const now = p.now ?? new Date();
  const slots = [...p.slots].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const out: Occurrence[] = [];
  let remaining = p.monthlyMinutes;

  for (let day = Date.parse(p.startDate); day < Date.parse(p.endDate); day += DAY_MS) {
    const date = new Date(day);
    for (const slot of slots) {
      if (slot.weekday !== date.getUTCDay()) continue;
      const minutes = Math.min(length, remaining);
      if (minutes < MIN_SESSION_MIN) return out;
      const startAt = zonedTime(date.toISOString().slice(0, 10), slot.startTime, p.timeZone);
      if (startAt < now) continue;
      out.push({ startAt, endAt: new Date(startAt.getTime() + minutes * 60_000) });
      remaining -= minutes;
    }
  }
  return out;
}

/** True when the two time ranges share at least a minute. */
export const overlaps = (a: Occurrence, b: Occurrence) => a.startAt < b.endAt && b.startAt < a.endAt;

/** A wall-clock date and "HH:mm" in `timeZone` → the UTC instant. */
export function zonedTime(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, h, min);
  // The zone's offset at the guess, re-checked once in case the guess fell across a DST change.
  let utc = wall - offsetAt(wall, timeZone);
  const second = offsetAt(utc, timeZone);
  if (wall - second !== utc) utc = wall - second;
  return new Date(utc);
}

function offsetAt(utcMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((x) => x.type === type)!.value);
  const asWall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return asWall - Math.floor(utcMs / 60_000) * 60_000;
}

const minutesOf = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};
