import {
  actualMinutes,
  bookedMinutes,
  chargeOf,
  currentRates,
  effectivePlatformFee,
  isBillable,
  monthKey,
  platformFeeCents,
  rateSource,
  resolveRate,
  sessionFeesCents,
  studentFeeCents,
  teacherIsPaid,
  teacherPayCents,
  type Rate,
} from './billing.js';

const day = (s: string) => new Date(`${s}T00:00:00Z`);

function rate(over: Partial<Rate>): Rate {
  return {
    id: Math.random().toString(36).slice(2),
    kind: 'STUDENT_FEE',
    basis: 'PER_SESSION',
    teacherId: null,
    courseId: null,
    studentId: null,
    amount: 100,
    cleared: false,
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

describe('chargeOf', () => {
  it('charges present, late and not-yet-evaluated students', () => {
    expect(chargeOf('PRESENT', true)).toEqual({ charged: true });
    expect(chargeOf('LATE', false)).toEqual({ charged: true });
    expect(chargeOf(null, false)).toEqual({ charged: true });
  });

  it('never charges an excused student', () => {
    expect(chargeOf('EXCUSED', true)).toEqual({ charged: false, reason: 'EXCUSED' });
  });

  it('charges an unexcused absence only when the center says so', () => {
    expect(chargeOf('ABSENT', true)).toEqual({ charged: true });
    expect(chargeOf('ABSENT', false)).toEqual({ charged: false, reason: 'ABSENT' });
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

  it("prefers the student's special price, then the course's, then the center's default", () => {
    const center = rate({ amount: 90 });
    const course = rate({ courseId: 'c1', amount: 120 });
    const special = rate({ courseId: 'c1', studentId: 's1', amount: 80 });
    expect(resolveRate([center, course, special], target)).toBe(special);
    expect(resolveRate([center, course], target)).toBe(course);
    expect(resolveRate([center], target)).toBe(center);
  });

  it('prices sessions with no course at the default', () => {
    const center = rate({ amount: 90 });
    const course = rate({ courseId: 'c1', amount: 120 });
    expect(resolveRate([center, course], { ...target, courseId: null })).toBe(center);
  });

  it('ignores prices for someone else', () => {
    const otherStudent = rate({ courseId: 'c1', studentId: 's2', amount: 1 });
    const otherCourse = rate({ courseId: 'c2', amount: 2 });
    const pay = rate({ kind: 'TEACHER_PAY', teacherId: 't1', amount: 4 });
    expect(resolveRate([otherStudent, otherCourse, pay], target)).toBeNull();
  });

  it("finds the teacher's pay", () => {
    const mine = rate({ kind: 'TEACHER_PAY', teacherId: 't1', basis: 'PERCENT', amount: 50 });
    const theirs = rate({ kind: 'TEACHER_PAY', teacherId: 't2', amount: 70 });
    expect(resolveRate([mine, theirs], { kind: 'TEACHER_PAY', teacherId: 't1', courseId: 'c1', at })).toBe(mine);
  });

  it('names where a price came from', () => {
    expect(rateSource(rate({}))).toBe('CENTER');
    expect(rateSource(rate({ courseId: 'c1' }))).toBe('COURSE');
    expect(rateSource(rate({ courseId: 'c1', studentId: 's1' }))).toBe('STUDENT');
    expect(rateSource(rate({ kind: 'TEACHER_PAY', teacherId: 't1' }))).toBe('TEACHER');
  });

  it('uses the price in effect when the session started', () => {
    const old = rate({ courseId: 'c1', amount: 100, effectiveFrom: day('2026-01-01') });
    const raise = rate({ courseId: 'c1', amount: 150, effectiveFrom: day('2026-10-01') });
    const future = rate({ courseId: 'c1', amount: 200, effectiveFrom: day('2026-11-01') });
    expect(resolveRate([old, raise, future], target)).toBe(raise);
    expect(resolveRate([old, raise, future], { ...target, at: day('2026-09-15') })).toBe(old);
    expect(resolveRate([future], target)).toBeNull();
  });

  it('keeps an older special price over a newer course price', () => {
    const special = rate({ courseId: 'c1', studentId: 's1', amount: 80, effectiveFrom: day('2026-01-01') });
    const newCourse = rate({ courseId: 'c1', amount: 150, effectiveFrom: day('2026-10-01') });
    expect(resolveRate([special, newCourse], target)).toBe(special);
  });

  it('a cleared special price hands back to the course price from then on', () => {
    const course = rate({ courseId: 'c1', amount: 150 });
    const special = rate({ courseId: 'c1', studentId: 's1', amount: 80, effectiveFrom: day('2026-02-01') });
    const ended = rate({ courseId: 'c1', studentId: 's1', amount: 0, cleared: true, effectiveFrom: day('2026-10-01') });
    expect(resolveRate([course, special, ended], target)).toBe(course);
    expect(resolveRate([course, special, ended], { ...target, at: day('2026-09-01') })).toBe(special);
  });

  it('a cleared course price falls back to the default', () => {
    const center = rate({ amount: 90 });
    const course = rate({ courseId: 'c1', amount: 150 });
    const ended = rate({ courseId: 'c1', amount: 0, cleared: true, effectiveFrom: day('2026-10-01') });
    expect(resolveRate([center, course, ended], target)).toBe(center);
  });
});

describe('currentRates', () => {
  it('keeps the latest value of each price, without ended ones', () => {
    const now = day('2026-10-10');
    const old = rate({ courseId: 'c1', amount: 100, effectiveFrom: day('2026-01-01') });
    const current = rate({ courseId: 'c1', amount: 150, effectiveFrom: day('2026-10-01') });
    const special = rate({ courseId: 'c1', studentId: 's1', amount: 80 });
    const ended = rate({ courseId: 'c1', studentId: 's1', cleared: true, effectiveFrom: day('2026-10-05') });
    const center = rate({ amount: 90 });
    expect(currentRates([old, current, special, ended, center], now)).toEqual([current, center]);
  });
});

describe('money', () => {
  it('charges a flat amount per session, whatever its length', () => {
    expect(studentFeeCents({ amount: 250 })).toBe(25_000);
    expect(studentFeeCents({ amount: 99.99 })).toBe(9_999);
  });

  it('pays teachers per session, or as a share of the fees', () => {
    expect(teacherPayCents({ basis: 'PER_SESSION', amount: 200 }, 50_000)).toBe(20_000);
    expect(teacherPayCents({ basis: 'PERCENT', amount: 60 }, 50_000)).toBe(30_000);
  });

  it('owes a fixed pay unless every student was excused', () => {
    expect(teacherIsPaid(['PRESENT', 'EXCUSED'])).toBe(true);
    expect(teacherIsPaid(['ABSENT'])).toBe(true);
    expect(teacherIsPaid([null])).toBe(true);
    expect(teacherIsPaid([])).toBe(true);
    expect(teacherIsPaid(['EXCUSED', 'EXCUSED'])).toBe(false);
  });

  it("takes the center's own fee, else its package's", () => {
    expect(effectivePlatformFee(5, 10)).toBe(5);
    expect(effectivePlatformFee(null, 10)).toBe(10);
    expect(effectivePlatformFee(0, 10)).toBeNull();
    expect(effectivePlatformFee(null, null)).toBeNull();
  });

  it('takes the platform fee only when one is set', () => {
    expect(platformFeeCents(50_000, 10)).toBe(5_000);
    expect(platformFeeCents(50_000, 12.5)).toBe(6_250);
    expect(platformFeeCents(50_000, 0)).toBe(0);
    expect(platformFeeCents(50_000, null)).toBe(0);
  });

  it('prices a whole session from its charged attendees', () => {
    const center = rate({ amount: 100 });
    const special = rate({ studentId: 's2', courseId: 'c1', amount: 50 });
    const session = {
      status: 'COMPLETED' as const,
      startAt: new Date('2026-10-01T10:00:00Z'),
      teacherId: 't1',
      courseId: 'c1',
      attendees: [
        { studentId: 's1', status: 'PRESENT' as const },
        { studentId: 's2', status: null },
        { studentId: 's3', status: 'ABSENT' as const },
        { studentId: 's4', status: 'EXCUSED' as const },
      ],
    };
    // s1 100, s2 their special 50, s3 100 while absences are charged, s4 excused.
    expect(sessionFeesCents(session, [center, special], true)).toBe(25_000);
    expect(sessionFeesCents(session, [center, special], false)).toBe(15_000);
    expect(sessionFeesCents({ ...session, status: 'CANCELED' }, [center, special], true)).toBe(0);
  });
});

describe('monthKey', () => {
  it('uses the center time zone', () => {
    // 22:30 UTC on 30 Sep is 01:30 on 1 Oct in Cairo (UTC+3 in summer time).
    expect(monthKey(new Date('2026-09-30T22:30:00Z'), 'Africa/Cairo')).toBe('2026-10');
    expect(monthKey(new Date('2026-09-30T22:30:00Z'), 'UTC')).toBe('2026-09');
  });
});
