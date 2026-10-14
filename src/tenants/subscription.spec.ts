import { describe, expect, it } from 'vitest';
import { isExpired } from './subscription.js';

const now = new Date('2026-10-14T12:00:00Z');
const later = new Date('2026-11-01T00:00:00Z');
const earlier = new Date('2026-10-01T00:00:00Z');

describe('isExpired', () => {
  it('is active until the period ends', () => {
    expect(isExpired({ status: 'TRIALING', currentPeriodEnd: later }, now)).toBe(false);
    expect(isExpired({ status: 'ACTIVE', currentPeriodEnd: later }, now)).toBe(false);
    expect(isExpired({ status: 'PAST_DUE', currentPeriodEnd: later }, now)).toBe(false);
  });

  it('lapses once the period is over, whatever the status', () => {
    expect(isExpired({ status: 'TRIALING', currentPeriodEnd: earlier }, now)).toBe(true);
    expect(isExpired({ status: 'ACTIVE', currentPeriodEnd: earlier }, now)).toBe(true);
  });

  it('lapses right away when canceled', () => {
    expect(isExpired({ status: 'CANCELED', currentPeriodEnd: later }, now)).toBe(true);
  });

  it('has nothing to enforce without a subscription', () => {
    expect(isExpired(null, now)).toBe(false);
  });
});
