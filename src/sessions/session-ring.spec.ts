import { RING_MS } from './call-rules.js';
import { callsStudent, ringLeftMs, sessionCalling } from './session-ring.js';

const now = new Date('2026-11-01T16:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const live = { status: 'LIVE' as const, startedAt: ago(30_000), endedAt: null, attended: false };

describe('callsStudent', () => {
  it('calls a student who has not entered a live session', () => {
    expect(callsStudent(live)).toBe(true);
  });

  it('stops once they entered, the meeting dropped, or the session is not live', () => {
    expect(callsStudent({ ...live, attended: true })).toBe(false);
    expect(callsStudent({ ...live, endedAt: ago(1_000) })).toBe(false);
    expect(callsStudent({ ...live, status: 'SCHEDULED' })).toBe(false);
    expect(callsStudent({ ...live, status: 'COMPLETED' })).toBe(false);
    expect(callsStudent({ ...live, status: 'CANCELED' })).toBe(false);
  });
});

describe('sessionCalling', () => {
  it('picks the most recently started session that calls', () => {
    const older = { ...live, id: 'a', startedAt: ago(10 * 60_000) };
    const newer = { ...live, id: 'b', startedAt: ago(60_000) };
    const entered = { ...live, id: 'c', startedAt: ago(1_000), attended: true };
    expect(sessionCalling([older, entered, newer])?.id).toBe('b');
  });

  it('is null when nothing calls', () => {
    expect(sessionCalling([{ ...live, attended: true }])).toBeNull();
    expect(sessionCalling([])).toBeNull();
  });
});

describe('ringLeftMs', () => {
  it('rings for RING_MS from the start, then not at all', () => {
    expect(ringLeftMs(now, now)).toBe(RING_MS);
    expect(ringLeftMs(ago(30_000), now)).toBe(RING_MS - 30_000);
    expect(ringLeftMs(ago(RING_MS), now)).toBe(0);
    expect(ringLeftMs(ago(RING_MS + 60_000), now)).toBe(0);
  });

  it('does not ring without a start time', () => {
    expect(ringLeftMs(null, now)).toBe(0);
  });
});
