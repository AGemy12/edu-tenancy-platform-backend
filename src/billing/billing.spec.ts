import {
  actualMinutes,
  bookedMinutes,
  chargeCents,
  isBillable,
  monthKey,
  rateStatuses,
  resolveRate,
  teacherPayCents,
  type Rate,
} from './billing.js';

const day = (s: string) => new Date(`${s}T00:00:00Z`);

function rate(over: Partial<Rate>): Rate {
  return {
    id: Math.random().toString(36).slice(2),
    kind: 'STUDENT_FEE',
    basis: 'PER_HOUR',
    teacherId: 't1',
    courseId: null,
    studentId: null,
    amount: 100,
    effectiveFrom: day('2026-01-01'),
    ...over,
  };
}

describe('isBillable', () => {
  it('charges once the teacher entered: live or completed', () => {
    expect(isBillable('LIVE')).toBe(true);
    expect(isBillable('COMPLETED')).toBe(true);
  });

  it('never charges canceled, missed or upcoming sessions', () => {
    expect(isBillable('CANCELED')).toBe(false);
    expect(isBillable('MISSED')).toBe(false);
    expect(isBillable('SCHEDULED')).toBe(false);
  });
});

describe('durations', () => {
  it('uses the booked slot', () => {
    expect(bookedMinutes({ startAt: new Date('2026-10-01T10:00:00Z'), endAt: new Date('2026-10-01T11:30:00Z') })).toBe(90);
  });

  it('reports the real length only when both ends are known', () => {
    expect(actualMinutes({ startedAt: new Date('2026-10-01T10:05:00Z'), endedAt: new Date('2026-10-01T11:00:00Z') })).toBe(55);
    expect(actualMinutes({ startedAt: new Date('2026-10-01T10:05:00Z'), endedAt: null })).toBeNull();
  });
});

describe('resolveRate', () => {
  const at = day('2026-10-10');
  const target = { kind: 'STUDENT_FEE' as const, teacherId: 't1', courseId: 'c1', studentId: 's1', at };

  it('prefers student over course over the teacher default', () => {
    const base = rate({ amount: 100 });
    const course = rate({ courseId: 'c1', amount: 120 });
    const student = rate({ studentId: 's1', amount: 80 });
    expect(resolveRate([base, course, student], target)).toBe(student);
    expect(resolveRate([base, course], target)).toBe(course);
    expect(resolveRate([base], target)).toBe(base);
  });

  it('ignores rates for someone else', () => {
    const otherStudent = rate({ studentId: 's2', amount: 1 });
    const otherCourse = rate({ courseId: 'c2', amount: 2 });
    const otherTeacher = rate({ teacherId: 't2', amount: 3 });
    const pay = rate({ kind: 'TEACHER_PAY', amount: 4 });
    expect(resolveRate([otherStudent, otherCourse, otherTeacher, pay], target)).toBeNull();
  });

  it('uses the price in effect when the session started', () => {
    const old = rate({ amount: 100, effectiveFrom: day('2026-01-01') });
    const raise = rate({ amount: 150, effectiveFrom: day('2026-10-01') });
    const future = rate({ amount: 200, effectiveFrom: day('2026-11-01') });
    expect(resolveRate([old, raise, future], target)).toBe(raise);
    expect(resolveRate([old, raise, future], { ...target, at: day('2026-09-15') })).toBe(old);
    expect(resolveRate([future], target)).toBeNull();
  });

  it('keeps an older specific rate over a newer default', () => {
    const student = rate({ studentId: 's1', amount: 80, effectiveFrom: day('2026-01-01') });
    const newDefault = rate({ amount: 150, effectiveFrom: day('2026-10-01') });
    expect(resolveRate([student, newDefault], target)).toBe(student);
  });

  it('a course-and-student rate beats a student rate', () => {
    const student = rate({ studentId: 's1', amount: 80 });
    const both = rate({ studentId: 's1', courseId: 'c1', amount: 70 });
    expect(resolveRate([student, both], target)).toBe(both);
  });
});

describe('money', () => {
  it('charges by the minute without float drift', () => {
    expect(chargeCents(150, 60)).toBe(15_000);
    expect(chargeCents(150, 90)).toBe(22_500);
    expect(chargeCents(100, 45)).toBe(7_500);
    expect(chargeCents(99.99, 20)).toBe(3_333);
  });

  it('pays teachers per hour or as a share of the fees', () => {
    expect(teacherPayCents({ basis: 'PER_HOUR', amount: 80 }, 90, 50_000)).toBe(12_000);
    expect(teacherPayCents({ basis: 'PERCENT', amount: 60 }, 90, 50_000)).toBe(30_000);
  });
});

describe('rateStatuses', () => {
  it('marks the current, past and upcoming price for each scope', () => {
    const now = day('2026-10-10');
    const old = rate({ effectiveFrom: day('2026-01-01') });
    const current = rate({ effectiveFrom: day('2026-10-01') });
    const next = rate({ effectiveFrom: day('2026-11-01') });
    const course = rate({ courseId: 'c1', effectiveFrom: day('2026-02-01') });
    const s = rateStatuses([old, current, next, course], now);
    expect(s.get(old.id)).toBe('SUPERSEDED');
    expect(s.get(current.id)).toBe('ACTIVE');
    expect(s.get(next.id)).toBe('SCHEDULED');
    expect(s.get(course.id)).toBe('ACTIVE');
  });
});

describe('monthKey', () => {
  it('uses the center time zone', () => {
    // 22:30 UTC on 30 Sep is 01:30 on 1 Oct in Cairo (UTC+3 in summer time).
    expect(monthKey(new Date('2026-09-30T22:30:00Z'), 'Africa/Cairo')).toBe('2026-10');
    expect(monthKey(new Date('2026-09-30T22:30:00Z'), 'UTC')).toBe('2026-09');
  });
});
