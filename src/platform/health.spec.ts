import { assessHealth, type HealthInput } from './health.js';

const now = new Date('2026-04-15T12:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const GB = 1024 ** 3;

const healthy: HealthInput = {
  createdAt: daysAgo(120),
  subscription: { status: 'ACTIVE', periodEnd: daysAgo(-60) },
  lastActiveAt: daysAgo(1),
  sessions30: 20,
  sessionsPrev30: 18,
  teachers: { used: 2, max: 10 },
  students: { used: 30, max: 100 },
  storage: { used: 1 * GB, max: 10 * GB },
};
const assess = (patch: Partial<HealthInput>) => assessHealth({ ...healthy, ...patch }, now);

describe('assessHealth: risk', () => {
  it('finds nothing wrong with an active, growing-as-usual center', () => {
    expect(assess({})).toEqual({ risk: [], severity: null, growth: [] });
  });

  it('flags inactivity, and a center nobody ever used once the grace period is over', () => {
    expect(assess({ lastActiveAt: daysAgo(20) }).risk).toEqual([{ code: 'INACTIVE', value: 20 }]);
    expect(assess({ lastActiveAt: daysAgo(13) }).risk).toEqual([]);
    expect(assess({ lastActiveAt: null }).risk).toEqual([{ code: 'NEVER_ACTIVE' }]);
    expect(assess({ lastActiveAt: null, createdAt: daysAgo(3) }).risk).toEqual([]);
  });

  it('flags no sessions, and a steep drop from a real baseline', () => {
    expect(assess({ sessions30: 0 }).risk).toEqual([{ code: 'NO_SESSIONS' }]);
    expect(assess({ sessions30: 4, sessionsPrev30: 20 }).risk).toEqual([{ code: 'SESSIONS_DROP', value: 80 }]);
    expect(assess({ sessions30: 1, sessionsPrev30: 3 }).risk).toEqual([]);
    expect(assess({ sessions30: 0, createdAt: daysAgo(10) }).risk).toEqual([]);
  });

  it('flags a stalled trial instead of missing sessions', () => {
    const trial = { status: 'TRIALING' as const, periodEnd: daysAgo(-10) };
    expect(assess({ subscription: trial, createdAt: daysAgo(4), sessions30: 0 }).risk).toEqual([{ code: 'TRIAL_STALLED' }]);
    expect(assess({ subscription: trial, createdAt: daysAgo(4), students: { used: 0, max: 100 } }).risk).toEqual([{ code: 'TRIAL_STALLED' }]);
    expect(assess({ subscription: trial, createdAt: daysAgo(2), sessions30: 0 }).risk).toEqual([]);
  });

  it('adds a near end only next to another sign, and rates severity', () => {
    const ending = { status: 'ACTIVE' as const, periodEnd: daysAgo(-5) };
    expect(assess({ subscription: ending }).risk).toEqual([]);
    const h = assess({ subscription: ending, lastActiveAt: daysAgo(30) });
    expect(h.risk).toEqual([{ code: 'INACTIVE', value: 30 }, { code: 'ENDING_SOON', value: 5 }]);
    expect(h.severity).toBe('high');
    expect(assess({ lastActiveAt: daysAgo(30) }).severity).toBe('medium');
    expect(assess({ lastActiveAt: daysAgo(30), sessions30: 0 }).severity).toBe('high');
    expect(assess({ subscription: { status: 'PAST_DUE', periodEnd: daysAgo(-20) } })).toMatchObject({ risk: [{ code: 'PAST_DUE' }], severity: 'high' });
  });
});

describe('assessHealth: growth', () => {
  it('flags limits at 80% or more, with the share used', () => {
    const h = assess({ teachers: { used: 8, max: 10 }, students: { used: 100, max: 100 }, storage: { used: 7.9 * GB, max: 10 * GB } });
    expect(h.growth).toEqual([
      { code: 'TEACHERS_LIMIT', value: 80 },
      { code: 'STUDENTS_LIMIT', value: 100 },
    ]);
  });

  it('flags an engaged trial as ready to convert', () => {
    const h = assess({ subscription: { status: 'TRIALING', periodEnd: daysAgo(-3) }, sessions30: 6 });
    expect(h.growth).toEqual([{ code: 'TRIAL_ENGAGED', value: 6 }]);
  });
});
