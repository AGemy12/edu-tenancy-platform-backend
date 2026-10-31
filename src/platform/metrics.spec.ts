import { monthStarts, mrrByMonth, revenueAt, stateAt, trialFunnel, type Change } from './metrics.js';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const change = (at: string, status: Change['status'], price: number, periodEnd: string | null = null, currency = 'EGP'): Change => ({
  at: d(at),
  status,
  price,
  periodEnd: periodEnd ? d(periodEnd) : null,
  currency,
});

describe('revenueAt', () => {
  const h = [change('2026-01-10', 'TRIALING', 300, '2026-01-24'), change('2026-01-20', 'ACTIVE', 300, '2026-02-20')];

  it('reads the change in force at the instant', () => {
    expect(stateAt(h, d('2026-01-01'))).toBeNull();
    expect(stateAt(h, d('2026-01-15'))?.status).toBe('TRIALING');
    expect(stateAt(h, d('2026-01-20'))?.status).toBe('ACTIVE');
  });

  it('counts paying centers only: not trials, free packages, canceled or lapsed periods', () => {
    expect(revenueAt(h, d('2026-01-15'))).toBeNull();
    expect(revenueAt(h, d('2026-02-01'))).toEqual({ amount: 300, currency: 'EGP' });
    expect(revenueAt(h, d('2026-02-20'))).toBeNull();
    expect(revenueAt([change('2026-01-01', 'ACTIVE', 0)], d('2026-02-01'))).toBeNull();
    expect(revenueAt([change('2026-01-01', 'CANCELED', 300, '2027-01-01')], d('2026-02-01'))).toBeNull();
    expect(revenueAt([change('2026-01-01', 'PAST_DUE', 300, '2027-01-01')], d('2026-02-01'))).toEqual({ amount: 300, currency: 'EGP' });
    expect(revenueAt([change('2026-01-01', 'ACTIVE', 300)], d('2030-01-01'))).toEqual({ amount: 300, currency: 'EGP' });
  });
});

describe('mrrByMonth', () => {
  const now = d('2026-04-15');

  it('lists UTC month starts ending with the current month', () => {
    expect(monthStarts(now, 3)).toEqual([d('2026-02-01'), d('2026-03-01'), d('2026-04-01')]);
    expect(monthStarts(d('2026-01-31'), 2)).toEqual([d('2025-12-01'), d('2026-01-01')]);
  });

  it('explains each month: start + new + expansion − contraction − churned = mrr', () => {
    const histories = [
      // Pays from February, upgrades in March.
      [change('2026-02-05', 'ACTIVE', 300), change('2026-03-10', 'ACTIVE', 500)],
      // Pays from before the window, downgrades in March, cancels in April.
      [change('2025-12-01', 'ACTIVE', 400), change('2026-03-02', 'ACTIVE', 250), change('2026-04-03', 'CANCELED', 250)],
      // Pays until its period lapses mid-March.
      [change('2025-12-01', 'ACTIVE', 100, '2026-03-20')],
      // A trial that never pays.
      [change('2026-02-01', 'TRIALING', 300, '2026-02-15')],
    ];
    const { byCurrency, logos } = mrrByMonth(histories, now, 3);
    const egp = byCurrency.get('EGP')!;
    expect(egp.map((m) => m.month)).toEqual(['2026-02', '2026-03', '2026-04']);
    expect(egp[0]).toEqual({ month: '2026-02', start: 500, mrr: 800, new: 300, expansion: 0, contraction: 0, churned: 0, paying: 3 });
    expect(egp[1]).toEqual({ month: '2026-03', start: 800, mrr: 750, new: 0, expansion: 200, contraction: 150, churned: 100, paying: 2 });
    expect(egp[2]).toEqual({ month: '2026-04', start: 750, mrr: 500, new: 0, expansion: 0, contraction: 0, churned: 250, paying: 1 });
    for (const m of egp) expect(m.start + m.new + m.expansion - m.contraction - m.churned).toBe(m.mrr);
    expect(logos).toEqual([
      { month: '2026-02', start: 2, paying: 3, gained: 1, lost: 0 },
      { month: '2026-03', start: 3, paying: 2, gained: 0, lost: 1 },
      { month: '2026-04', start: 2, paying: 1, gained: 0, lost: 1 },
    ]);
  });

  it('keeps currencies apart; a switch is churn in one and new in the other', () => {
    const { byCurrency, logos } = mrrByMonth([[change('2026-01-01', 'ACTIVE', 300), change('2026-04-02', 'ACTIVE', 20, null, 'USD')]], now, 1);
    expect(byCurrency.get('EGP')![0]).toMatchObject({ start: 300, mrr: 0, churned: 300 });
    expect(byCurrency.get('USD')![0]).toMatchObject({ start: 0, mrr: 20, new: 20, paying: 1 });
    expect(logos[0]).toMatchObject({ gained: 0, lost: 0, paying: 1 });
  });
});

describe('trialFunnel', () => {
  const now = d('2026-04-15');

  it('counts converted, lost and running trials from the window, and the rate over decided ones', () => {
    const f = trialFunnel(
      [
        [change('2026-03-01', 'TRIALING', 300, '2026-03-15'), change('2026-03-14', 'ACTIVE', 300, '2026-04-14')], // converted, since lapsed
        [change('2026-03-01', 'TRIALING', 300, '2026-03-15')], // ran out
        [change('2026-03-20', 'TRIALING', 300, '2026-04-03'), change('2026-03-25', 'CANCELED', 300, '2026-04-03')], // canceled
        [change('2026-04-10', 'TRIALING', 300, '2026-04-24')], // still running
        [change('2026-04-01', 'TRIALING', 300, '2026-04-14'), change('2026-04-05', 'ACTIVE', 0, null)], // moved to a free package
        [change('2025-10-01', 'TRIALING', 300, '2025-10-15'), change('2025-10-10', 'ACTIVE', 300)], // before the window
        [change('2026-03-01', 'ACTIVE', 300)], // granted without a trial
      ],
      now,
    );
    expect(f).toEqual({ windowDays: 90, started: 5, converted: 1, lost: 3, open: 1, rate: 0.25 });
  });

  it('has no rate before any trial is decided', () => {
    expect(trialFunnel([[change('2026-04-10', 'TRIALING', 300, '2026-04-24')]], now).rate).toBeNull();
  });
});
