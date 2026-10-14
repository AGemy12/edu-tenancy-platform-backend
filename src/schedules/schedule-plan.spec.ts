import { describe, expect, it } from 'vitest';
import { periodEnd, planProblem, planSessions, zonedTime } from './schedule-plan.js';

const SUN = 0;
const TUE = 2;
const SAT = 6;

describe('zonedTime', () => {
  it('converts a wall-clock time in a fixed-offset zone', () => {
    expect(zonedTime('2026-10-18', '18:00', 'Asia/Riyadh').toISOString()).toBe('2026-10-18T15:00:00.000Z');
  });

  it('follows daylight saving changes', () => {
    // Berlin leaves summer time on 25 Oct 2026.
    expect(zonedTime('2026-10-24', '18:00', 'Europe/Berlin').toISOString()).toBe('2026-10-24T16:00:00.000Z');
    expect(zonedTime('2026-10-26', '18:00', 'Europe/Berlin').toISOString()).toBe('2026-10-26T17:00:00.000Z');
  });
});

describe('periodEnd', () => {
  it('ends on the same day next month (exclusive)', () => {
    expect(periodEnd('2026-10-14')).toBe('2026-11-14');
    expect(periodEnd('2026-12-05')).toBe('2027-01-05');
  });

  it('rolls to the 1st when next month is shorter', () => {
    expect(periodEnd('2027-01-31')).toBe('2027-03-01');
    expect(periodEnd('2026-03-31')).toBe('2026-05-01');
  });
});

describe('planProblem', () => {
  const slots = [
    { weekday: SUN, startTime: '18:00' },
    { weekday: TUE, startTime: '18:00' },
  ];

  it('accepts whole-minute sessions that fit the week', () => {
    expect(planProblem({ monthlyMinutes: 600, weeklyMinutes: 120, slots })).toBeNull();
  });

  it('rejects more weekly than monthly hours', () => {
    expect(planProblem({ monthlyMinutes: 60, weeklyMinutes: 120, slots })?.key).toBe('schedules.weeklyAboveMonthly');
  });

  it('rejects sessions that are too short or not whole minutes', () => {
    expect(planProblem({ monthlyMinutes: 600, weeklyMinutes: 20, slots })?.key).toBe('schedules.sessionTooShort');
    const three = [...slots, { weekday: SAT, startTime: '10:00' }];
    expect(planProblem({ monthlyMinutes: 600, weeklyMinutes: 100, slots: three })?.key).toBe('schedules.sessionTooShort');
  });

  it('rejects duplicate and overlapping slots, including across Saturday night', () => {
    const dup = [slots[0], { ...slots[0] }];
    expect(planProblem({ monthlyMinutes: 600, weeklyMinutes: 120, slots: dup })?.key).toBe('schedules.duplicateSlot');
    const close = [slots[0], { weekday: SUN, startTime: '18:30' }];
    expect(planProblem({ monthlyMinutes: 600, weeklyMinutes: 120, slots: close })?.key).toBe('schedules.slotsOverlap');
    const wrap = [
      { weekday: SAT, startTime: '23:30' },
      { weekday: SUN, startTime: '00:00' },
    ];
    expect(planProblem({ monthlyMinutes: 600, weeklyMinutes: 120, slots: wrap })?.key).toBe('schedules.slotsOverlap');
  });
});

describe('planSessions', () => {
  const base = {
    startDate: '2026-11-01', // a Sunday
    endDate: '2026-12-01',
    timeZone: 'Asia/Riyadh',
    now: new Date('2026-10-01T00:00:00Z'),
  };

  it('10 monthly hours at 2 a week over Sun + Tue: 1-hour sessions until the hours run out', () => {
    const out = planSessions({
      ...base,
      monthlyMinutes: 600,
      weeklyMinutes: 120,
      slots: [
        { weekday: TUE, startTime: '18:00' },
        { weekday: SUN, startTime: '17:00' },
      ],
    });
    // November 2026 has 5 Sundays and 4 Tuesdays: 9 one-hour slots, 9 of the 10 hours.
    expect(out).toHaveLength(9);
    expect(out[0].startAt.toISOString()).toBe('2026-11-01T14:00:00.000Z');
    expect(out[1].startAt.toISOString()).toBe('2026-11-03T15:00:00.000Z');
    expect(out.every((o) => o.endAt.getTime() - o.startAt.getTime() === 60 * 60_000)).toBe(true);
  });

  it('stops at the monthly hours and shortens the last session to fit', () => {
    const out = planSessions({ ...base, monthlyMinutes: 300, weeklyMinutes: 120, slots: [{ weekday: SUN, startTime: '10:00' }] });
    expect(out.map((o) => (o.endAt.getTime() - o.startAt.getTime()) / 60_000)).toEqual([120, 120, 60]);
  });

  it("skips slots that are already past and doesn't count them", () => {
    const out = planSessions({
      ...base,
      now: new Date('2026-11-10T00:00:00Z'),
      monthlyMinutes: 600,
      weeklyMinutes: 60,
      slots: [{ weekday: SUN, startTime: '10:00' }],
    });
    expect(out.map((o) => o.startAt.toISOString().slice(0, 10))).toEqual(['2026-11-15', '2026-11-22', '2026-11-29']);
  });

  it('drops a leftover shorter than the minimum session', () => {
    const out = planSessions({ ...base, monthlyMinutes: 130, weeklyMinutes: 60, slots: [{ weekday: SUN, startTime: '10:00' }] });
    expect(out).toHaveLength(2);
  });
});
