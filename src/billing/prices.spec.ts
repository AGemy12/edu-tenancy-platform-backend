import { firstEffectiveFrom, planRateWrite, splitRows, type StoredRate } from './prices.js';

const now = new Date('2026-11-05T12:00:00Z');
const row = (over: Partial<StoredRate>): StoredRate => ({
  id: 'r',
  basis: 'PER_SESSION',
  amount: 100,
  cleared: false,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  ...over,
});
const value = (amount: number, basis: 'PER_SESSION' | 'PERCENT' = 'PER_SESSION') => ({ basis, amount });

describe('splitRows', () => {
  it('finds the row in effect, the one before it, and those still to come', () => {
    const a = row({ id: 'a', effectiveFrom: new Date('2026-01-01') });
    const b = row({ id: 'b', effectiveFrom: new Date('2026-06-01') });
    const c = row({ id: 'c', effectiveFrom: new Date('2026-12-01') });
    expect(splitRows([c, a, b], now)).toEqual({ current: b, previous: a, future: [c] });
    expect(splitRows([], now)).toEqual({ current: null, previous: null, future: [] });
  });
});

describe('planRateWrite', () => {
  const base = { previous: null, used: false, now, special: false };

  it('does nothing when the price is unchanged', () => {
    expect(planRateWrite({ ...base, current: row({}), value: value(100) })).toEqual({ op: 'none' });
    expect(planRateWrite({ ...base, current: null, value: null })).toEqual({ op: 'none' });
    expect(planRateWrite({ ...base, current: row({ cleared: true }), value: null })).toEqual({ op: 'none' });
  });

  it('a first price covers past sessions too, except a special price which starts now', () => {
    expect(planRateWrite({ ...base, current: null, value: value(100) })).toEqual({ op: 'insert', effectiveFrom: new Date(0), value: value(100) });
    expect(planRateWrite({ ...base, special: true, current: null, value: value(80) })).toEqual({ op: 'insert', effectiveFrom: now, value: value(80) });
    expect(firstEffectiveFrom(true, now)).toBe(now);
  });

  it('corrects a price nobody was billed at yet', () => {
    expect(planRateWrite({ ...base, current: row({ id: 'cur' }), value: value(120) })).toEqual({ op: 'update', id: 'cur', value: value(120) });
    expect(planRateWrite({ ...base, current: row({ id: 'cur' }), value: value(50, 'PERCENT') })).toEqual({
      op: 'update',
      id: 'cur',
      value: value(50, 'PERCENT'),
    });
  });

  it('keeps the old price for sessions already billed at it', () => {
    expect(planRateWrite({ ...base, used: true, current: row({}), value: value(120) })).toEqual({ op: 'insert', effectiveFrom: now, value: value(120) });
    expect(planRateWrite({ ...base, used: true, current: row({}), value: null })).toEqual({ op: 'insert', effectiveFrom: now, value: null });
  });

  it('removes an unused price outright, unless an older one would come back', () => {
    expect(planRateWrite({ ...base, current: row({ id: 'cur' }), value: null })).toEqual({ op: 'delete', id: 'cur' });
    expect(planRateWrite({ ...base, current: row({ id: 'cur' }), previous: row({ id: 'old', cleared: true }), value: null })).toEqual({
      op: 'delete',
      id: 'cur',
    });
    expect(planRateWrite({ ...base, current: row({ id: 'cur' }), previous: row({ id: 'old' }), value: null })).toEqual({
      op: 'update',
      id: 'cur',
      value: null,
    });
  });
});
