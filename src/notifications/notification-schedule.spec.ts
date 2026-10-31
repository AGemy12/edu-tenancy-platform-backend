import { subscriptionNotice } from './notification-schedule.js';

const now = new Date('2026-10-20T12:00:00Z');
const inDays = (d: number) => new Date(now.getTime() + d * 24 * 60 * 60_000);

describe('subscriptionNotice', () => {
  it('stays quiet until three days before the end', () => {
    expect(subscriptionNotice(inDays(3.5), now)).toBeNull();
  });

  it('warns in the last three days, once per period end', () => {
    const end = inDays(2);
    expect(subscriptionNotice(end, now)).toEqual({ kind: 'EXPIRING', key: `EXPIRING:${end.toISOString()}` });
    expect(subscriptionNotice(end, inDays(1))?.key).toBe(subscriptionNotice(end, now)?.key);
  });

  it('says it expired once the end has passed, but not for old news', () => {
    expect(subscriptionNotice(now, now)?.kind).toBe('EXPIRED');
    expect(subscriptionNotice(inDays(-6), now)?.kind).toBe('EXPIRED');
    expect(subscriptionNotice(inDays(-8), now)).toBeNull();
  });

  it('starts over after a renewal', () => {
    expect(subscriptionNotice(inDays(1), now)?.key).not.toBe(subscriptionNotice(inDays(2), now)?.key);
  });
});
