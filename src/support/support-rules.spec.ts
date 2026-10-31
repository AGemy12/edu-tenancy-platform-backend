import { accessUntil, requestState, sessionEnd, PENDING_HOURS } from './support-rules.js';

const now = new Date('2026-10-20T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

describe('requestState', () => {
  it('keeps a pending request open until nobody answered it in time', () => {
    expect(requestState({ status: 'PENDING', createdAt: hoursAgo(1), accessUntil: null }, now)).toBe('PENDING');
    expect(requestState({ status: 'PENDING', createdAt: hoursAgo(PENDING_HOURS), accessUntil: null }, now)).toBe('EXPIRED');
  });

  it('keeps an approval only inside its window', () => {
    expect(requestState({ status: 'APPROVED', createdAt: hoursAgo(5), accessUntil: hoursAgo(-1) }, now)).toBe('APPROVED');
    expect(requestState({ status: 'APPROVED', createdAt: hoursAgo(5), accessUntil: now }, now)).toBe('EXPIRED');
    expect(requestState({ status: 'APPROVED', createdAt: hoursAgo(5), accessUntil: null }, now)).toBe('EXPIRED');
  });

  it('leaves decided requests as they are', () => {
    for (const status of ['DENIED', 'CANCELED', 'REVOKED'] as const) {
      expect(requestState({ status, createdAt: hoursAgo(500), accessUntil: hoursAgo(400) }, now)).toBe(status);
    }
  });
});

describe('session and access windows', () => {
  it('opens access for the chosen hours', () => {
    expect(accessUntil(4, now)).toEqual(new Date('2026-10-20T16:00:00Z'));
  });

  it('ends a session after its minutes, or at the end of the approval if that comes first', () => {
    expect(sessionEnd({ minutes: 60, accessUntil: hoursAgo(-4) }, now)).toEqual(new Date('2026-10-20T13:00:00Z'));
    expect(sessionEnd({ minutes: 60, accessUntil: new Date('2026-10-20T12:20:00Z') }, now)).toEqual(new Date('2026-10-20T12:20:00Z'));
  });
});
