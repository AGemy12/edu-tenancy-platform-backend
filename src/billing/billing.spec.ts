import {
  actualMinutes,
  bookedMinutes,
  chargeCents,
  isBillable,
  monthKey,
  platformFeeCents,
  rateSource,
  rateStatuses,
  resolveRate,
  sessionFeesCents,
  studentFeeCents,
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

  it('prefers student over course over teacher over the center default', () => {
    const center = rate({ teacherId: null, amount: 90 });
    const base = rate({ amount: 100 });
    const course = rate({ courseId: 'c1', teacherId: null, amount: 120 });
    const student = rate({ studentId: 's1', teacherId: null, amount: 80 });
    expect(resolveRate([center, base, course, student], target)).toBe(student);
    expect(resolveRate([center, base, course], target)).toBe(course);
    expect(resolveRate([center, base], target)).toBe(base);
    expect(resolveRate([center], target)).toBe(center);
  });

  it('a center-wide price applies to every teacher', () => {
    const center = rate({ teacherId: null, amount: 90 });
    expect(resolveRate([center], { ...target, teacherId: 't99' })).toBe(center);
  });

  it('ignores rates for someone else', () => {
    const otherStudent = rate({ studentId: 's2', amount: 1 });
    const otherCourse = rate({ courseId: 'c2', amount: 2 });
    const otherTeacher = rate({ teacherId: 't2', amount: 3 });
    const pay = rate({ kind: 'TEACHER_PAY', amount: 4 });
    expect(resolveRate([otherStudent, otherCourse, otherTeacher, pay], target)).toBeNull();
  });

  it('names the tier a rate came from', () => {
    expect(rateSource(rate({ teacherId: null }))).toBe('CENTER');
    expect(rateSource(rate({}))).toBe('TEACHER');
    expect(rateSource(rate({ courseId: 'c1' }))).toBe('COURSE');
    expect(rateSource(rate({ courseId: 'c1', studentId: 's1' }))).toBe('STUDENT');
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

  it('charges students by the hour or flat per session', () => {
    expect(studentFeeCents({ basis: 'PER_HOUR', amount: 100 }, 90)).toBe(15_000);
    expect(studentFeeCents({ basis: 'PER_SESSION', amount: 250 }, 90)).toBe(25_000);
    expect(studentFeeCents({ basis: 'PER_SESSION', amount: 250 }, 15)).toBe(25_000);
  });

  it('pays teachers per hour, per session, or as a share of the fees', () => {
    expect(teacherPayCents({ basis: 'PER_HOUR', amount: 80 }, 90, 50_000)).toBe(12_000);
    expect(teacherPayCents({ basis: 'PER_SESSION', amount: 200 }, 90, 50_000)).toBe(20_000);
    expect(teacherPayCents({ basis: 'PERCENT', amount: 60 }, 90, 50_000)).toBe(30_000);
  });

  it('takes the platform commission only when one is set', () => {
    expect(platformFeeCents(50_000, 10)).toBe(5_000);
    expect(platformFeeCents(50_000, 12.5)).toBe(6_250);
    expect(platformFeeCents(50_000, 0)).toBe(0);
    expect(platformFeeCents(50_000, null)).toBe(0);
  });

  it('prices a whole session from its attendees', () => {
    const center = rate({ teacherId: null, amount: 100 });
    const special = rate({ teacherId: null, studentId: 's2', basis: 'PER_SESSION', amount: 50 });
    const session = {
      status: 'COMPLETED' as const,
      startAt: new Date('2026-10-01T10:00:00Z'),
      endAt: new Date('2026-10-01T11:30:00Z'),
      teacherId: 't1',
      courseId: null,
      attendees: [{ studentId: 's1' }, { studentId: 's2' }, { studentId: 's3' }],
    };
    // s1 and s3: 100/h × 1.5h; s2: flat 50.
    expect(sessionFeesCents(session, [center, special])).toBe(35_000);
    expect(sessionFeesCents({ ...session, status: 'CANCELED' }, [center, special])).toBe(0);
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
