import { describe, expect, it } from 'vitest';
import {
  attendanceRate,
  buckets,
  dayCount,
  dayKey,
  distribution,
  isEvaluated,
  longestAbsences,
  monthStarts,
  outcomeOf,
  periodBounds,
  previousPeriod,
  punctualityRate,
  riskFlags,
  startDelay,
  summarizeSeats,
  tally,
  trailingAbsences,
  type Outcome,
} from './report-rules.js';

const seat = (attended: boolean, status: 'PRESENT' | 'LATE' | 'ABSENT' | 'EXCUSED' | null = null) => ({ attended, status });

describe('outcomeOf', () => {
  it('keeps canceled and missed sessions apart, whatever the seat says', () => {
    expect(outcomeOf({ status: 'CANCELED' }, seat(true, 'PRESENT'))).toBe('CANCELED');
    expect(outcomeOf({ status: 'MISSED' }, seat(false))).toBe('MISSED');
  });

  it("lets the teacher's evaluation decide", () => {
    expect(outcomeOf({ status: 'COMPLETED' }, seat(true, 'ABSENT'))).toBe('ABSENT');
    expect(outcomeOf({ status: 'COMPLETED' }, seat(false, 'LATE'))).toBe('LATE');
    expect(outcomeOf({ status: 'COMPLETED' }, seat(false, 'EXCUSED'))).toBe('EXCUSED');
  });

  it('counts a student who joined as present until evaluated', () => {
    expect(outcomeOf({ status: 'COMPLETED' }, seat(true))).toBe('PRESENT');
    expect(outcomeOf({ status: 'LIVE' }, seat(true))).toBe('PRESENT');
  });

  it('never turns a missing evaluation or a future session into an absence', () => {
    expect(outcomeOf({ status: 'COMPLETED' }, seat(false))).toBe('UNRECORDED');
    expect(outcomeOf({ status: 'SCHEDULED' }, seat(false))).toBe('UPCOMING');
    expect(outcomeOf({ status: 'LIVE' }, seat(false))).toBe('UPCOMING');
  });
});

describe('rates', () => {
  it('counts only present, late and absent seats', () => {
    const t = tally(['PRESENT', 'PRESENT', 'LATE', 'ABSENT', 'EXCUSED', 'UNRECORDED', 'UPCOMING', 'CANCELED', 'MISSED']);
    expect(attendanceRate(t)).toBe(3 / 4);
    expect(punctualityRate(t)).toBe(2 / 3);
  });

  it('has no rate before anything counts', () => {
    expect(attendanceRate(tally(['UPCOMING', 'EXCUSED']))).toBeNull();
    expect(punctualityRate(tally(['ABSENT']))).toBeNull();
  });
});

describe('absence runs', () => {
  const o = (...xs: Outcome[]) => xs;

  it('counts the absences up to now, skipping excused and unrecorded seats', () => {
    expect(trailingAbsences(o('PRESENT', 'ABSENT', 'EXCUSED', 'ABSENT', 'UNRECORDED', 'ABSENT'))).toBe(3);
    expect(trailingAbsences(o('ABSENT', 'LATE'))).toBe(0);
  });

  it('finds the longest run', () => {
    expect(longestAbsences(o('ABSENT', 'ABSENT', 'PRESENT', 'ABSENT', 'EXCUSED', 'ABSENT', 'ABSENT', 'LATE'))).toBe(3);
  });
});

describe('summarizeSeats', () => {
  it('sums time and ratings only where the student came', () => {
    const at = (d: number) => new Date(Date.UTC(2026, 9, d, 15));
    const s = summarizeSeats([
      { outcome: 'PRESENT', minutes: 60, rating: 8, at: at(1) },
      { outcome: 'LATE', minutes: 60, rating: 6, at: at(3) },
      { outcome: 'ABSENT', minutes: 60, rating: null, at: at(8) },
      { outcome: 'EXCUSED', minutes: 45, rating: null, at: at(5) },
      { outcome: 'UPCOMING', minutes: 60, rating: null, at: at(20) },
      { outcome: 'CANCELED', minutes: 60, rating: null, at: at(10) },
    ]);
    expect(s).toMatchObject({ seats: 6, held: 4, counted: 3, heldMinutes: 225, attendedMinutes: 120, averageRating: 7, streak: 1, longestStreak: 1 });
    expect(s.attendanceRate).toBeCloseTo(2 / 3);
  });
});

describe('riskFlags', () => {
  it('flags low attendance only once enough seats count', () => {
    const base = { streak: 0, examAverage: null, averageRating: null };
    expect(riskFlags({ ...base, tally: tally(['ABSENT', 'PRESENT']) })).toEqual([]);
    expect(riskFlags({ ...base, tally: tally(['ABSENT', 'ABSENT', 'PRESENT']) })).toEqual(['LOW_ATTENDANCE']);
  });

  it('flags streaks, low scores and low ratings', () => {
    expect(riskFlags({ tally: tally(['PRESENT', 'PRESENT', 'PRESENT', 'PRESENT']), streak: 3, examAverage: 42, averageRating: 4.5 })).toEqual([
      'ABSENCE_STREAK',
      'LOW_SCORES',
      'LOW_RATING',
    ]);
  });
});

describe('teachers', () => {
  it('measures how late a session started', () => {
    const startAt = new Date('2026-10-01T15:00:00Z');
    expect(startDelay({ startAt, startedAt: new Date('2026-10-01T15:07:20Z') })).toBe(7);
    expect(startDelay({ startAt, startedAt: new Date('2026-10-01T14:55:00Z') })).toBe(0);
    expect(startDelay({ startAt, startedAt: null })).toBeNull();
  });

  it('needs every seat evaluated', () => {
    expect(isEvaluated([{ status: 'PRESENT' }, { status: 'EXCUSED' }])).toBe(true);
    expect(isEvaluated([{ status: 'PRESENT' }, { status: null }])).toBe(false);
  });
});

describe('distribution', () => {
  it('sorts scores into bands', () => {
    expect(distribution([10, 49.9, 50, 64, 70, 80, 85, 100])).toEqual([2, 2, 1, 1, 2]);
  });
});

describe('periods', () => {
  it("covers whole days in the center's time zone", () => {
    const { start, end } = periodBounds('2026-10-01', '2026-10-31', 'Africa/Cairo');
    expect(start.toISOString()).toBe('2026-09-30T21:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-31T22:00:00.000Z'); // Cairo leaves summer time on Oct 30
  });

  it('puts a session after midnight on the right day', () => {
    expect(dayKey(new Date('2026-09-30T22:30:00Z'), 'Africa/Cairo')).toBe('2026-10-01');
  });

  it('finds the period of the same length just before', () => {
    expect(previousPeriod('2026-10-01', '2026-10-31')).toEqual({ from: '2026-08-31', to: '2026-09-30' });
    expect(dayCount('2026-10-01', '2026-10-31')).toBe(31);
  });

  it('buckets by day, week or month depending on the length', () => {
    expect(buckets('2026-10-01', '2026-10-07').unit).toBe('day');
    const weeks = buckets('2026-10-01', '2026-10-31');
    expect(weeks.unit).toBe('week');
    expect(weeks.list.at(-1)).toEqual({ from: '2026-10-29', to: '2026-10-31' });
    const months = buckets('2026-01-15', '2026-12-31');
    expect(months.unit).toBe('month');
    expect(months.list[0]).toEqual({ from: '2026-01-15', to: '2026-01-31' });
    expect(months.list).toHaveLength(12);
  });

  it('lists the months a period touches', () => {
    expect(monthStarts('2026-11-20', '2027-01-05')).toEqual(['2026-11-01', '2026-12-01', '2027-01-01']);
  });
});
