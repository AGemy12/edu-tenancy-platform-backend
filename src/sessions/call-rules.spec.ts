import { RING_MS, answers, callPair, callStatus, callWindowOpen, hangUpStatus, isOpenCall, presentCall, sessionForCall } from './call-rules.js';
import { EARLY_ENTRY_MIN, RECONNECT_GRACE_MIN } from './session-lifecycle.js';

const MIN = 60_000;

describe('callPair', () => {
  const teacher = { membershipId: 'mt', role: 'TEACHER' as const, teacherId: 't1', studentId: null };
  const student = { membershipId: 'ms', role: 'STUDENT' as const, teacherId: null, studentId: 's1' };
  const admin = { membershipId: 'ma', role: 'TENANT_ADMIN' as const, teacherId: null, studentId: null };

  it('finds the teacher and the student, whoever placed the call', () => {
    const pair = { teacherMembershipId: 'mt', studentMembershipId: 'ms', teacherId: 't1', studentId: 's1' };
    expect(callPair(teacher, student)).toEqual(pair);
    expect(callPair(student, teacher)).toEqual(pair);
  });

  it('is only for a teacher with a student', () => {
    expect(callPair(teacher, admin)).toBeNull();
    expect(callPair(student, admin)).toBeNull();
    expect(callPair(teacher, { ...teacher, membershipId: 'mt2', teacherId: 't2' })).toBeNull();
  });
});

describe('callWindowOpen', () => {
  const startAt = new Date('2026-10-29T16:00:00Z');
  const endAt = new Date('2026-10-29T17:00:00Z');
  const at = (minutes: number) => new Date(startAt.getTime() + minutes * MIN);

  it(`opens ${EARLY_ENTRY_MIN} minutes before the start`, () => {
    expect(callWindowOpen({ status: 'SCHEDULED', startAt, endAt }, at(-EARLY_ENTRY_MIN - 1))).toBe(false);
    expect(callWindowOpen({ status: 'SCHEDULED', startAt, endAt }, at(-EARLY_ENTRY_MIN))).toBe(true);
  });

  it(`stays open ${RECONNECT_GRACE_MIN} minutes past the planned end, for calling back`, () => {
    expect(callWindowOpen({ status: 'LIVE', startAt, endAt }, at(60 + RECONNECT_GRACE_MIN))).toBe(true);
    expect(callWindowOpen({ status: 'LIVE', startAt, endAt }, at(60 + RECONNECT_GRACE_MIN + 1))).toBe(false);
  });

  it('is closed for sessions that are over', () => {
    for (const status of ['COMPLETED', 'CANCELED', 'MISSED'] as const) {
      expect(callWindowOpen({ status, startAt, endAt }, at(10))).toBe(false);
    }
  });
});

describe('sessionForCall', () => {
  const now = new Date('2026-10-29T16:50:00Z');
  const s = (id: string, status: 'SCHEDULED' | 'LIVE', start: string, end: string) => ({ id, status, startAt: new Date(start), endAt: new Date(end) });

  it('prefers the live session', () => {
    const next = s('next', 'SCHEDULED', '2026-10-29T17:00:00Z', '2026-10-29T18:00:00Z');
    const live = s('live', 'LIVE', '2026-10-29T16:00:00Z', '2026-10-29T17:00:00Z');
    expect(sessionForCall([next, live], now)?.id).toBe('live');
  });

  it('otherwise takes the earliest open one', () => {
    const a = s('a', 'SCHEDULED', '2026-10-29T16:00:00Z', '2026-10-29T17:00:00Z');
    const b = s('b', 'SCHEDULED', '2026-10-29T17:00:00Z', '2026-10-29T18:00:00Z');
    expect(sessionForCall([b, a], now)?.id).toBe('a');
  });

  it('is null when none is on', () => {
    expect(sessionForCall([s('later', 'SCHEDULED', '2026-10-29T19:00:00Z', '2026-10-29T20:00:00Z')], now)).toBeNull();
    expect(sessionForCall([], now)).toBeNull();
  });
});

describe('call status', () => {
  const createdAt = new Date('2026-10-29T16:00:00Z');
  const after = (ms: number) => new Date(createdAt.getTime() + ms);
  const ringing = { status: 'RINGING' as const, createdAt, callerId: 'ms' };

  it('turns a ring nobody answered into a missed call', () => {
    expect(callStatus(ringing, after(RING_MS))).toBe('RINGING');
    expect(callStatus(ringing, after(RING_MS + 1))).toBe('MISSED');
    expect(isOpenCall(ringing, after(RING_MS + 1))).toBe(false);
    expect(callStatus({ ...ringing, status: 'ACTIVE' }, after(60 * MIN))).toBe('ACTIVE');
  });

  it('is answered by the other side only, while it rings', () => {
    expect(answers(ringing, 'mt', after(1_000))).toBe(true);
    expect(answers(ringing, 'ms', after(1_000))).toBe(false);
    expect(answers(ringing, 'mt', after(RING_MS + 1))).toBe(false);
    expect(answers({ ...ringing, status: 'ACTIVE' }, 'mt', after(1_000))).toBe(false);
  });

  it('hangs up into missed or ended, and never reopens a finished call', () => {
    expect(hangUpStatus(ringing, after(1_000))).toBe('MISSED');
    expect(hangUpStatus({ ...ringing, status: 'ACTIVE' }, after(1_000))).toBe('ENDED');
    expect(hangUpStatus({ ...ringing, status: 'ENDED' }, after(1_000))).toBeNull();
    expect(hangUpStatus(ringing, after(RING_MS + 1))).toBeNull();
  });

  it('presents the status as of now, without the link', () => {
    const row = { id: 'c1', sessionId: 's1', callerId: 'ms', status: 'RINGING' as const, answeredAt: null, endedAt: null, createdAt, joinUrl: 'https://zoom.us/j/1' };
    const shown = presentCall(row, after(RING_MS + 1));
    expect(shown.status).toBe('MISSED');
    expect(shown).not.toHaveProperty('joinUrl');
  });
});
