import type { SubscriptionStatus } from '../generated/prisma/enums.js';

/**
 * Center health for the platform operator: which customers may leave (risk) and which are
 * outgrowing their package (growth). Pure rules over activity and usage the service gathers.
 */

export const HEALTH = {
  /** No admin or teacher activity for this long counts as inactive. */
  inactiveDays: 14,
  /** New centers get this long before missing activity counts against them. */
  graceDays: 7,
  /** A trial this old with no students or no sessions is stalled. */
  trialStalledDays: 3,
  /** Sessions fell below this share of the previous 30 days… */
  dropRatio: 0.5,
  /** …from at least this many. */
  dropMinPrevious: 4,
  /** The period ends within this many days. */
  endingDays: 14,
  /** Usage at or above this share of a package limit is a growth signal. */
  limitRatio: 0.8,
  /** A trial with this many sessions in 30 days is ready to convert. */
  engagedTrialSessions: 5,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type Usage = { used: number; max: number };

export type HealthInput = {
  createdAt: Date;
  subscription: { status: SubscriptionStatus; periodEnd: Date | null } | null;
  /** Latest sign-in or token refresh by any admin or teacher of the center. */
  lastActiveAt: Date | null;
  sessions30: number;
  sessionsPrev30: number;
  teachers: Usage;
  students: Usage;
  storage: Usage; // bytes
};

export type RiskCode = 'PAST_DUE' | 'NEVER_ACTIVE' | 'INACTIVE' | 'TRIAL_STALLED' | 'NO_SESSIONS' | 'SESSIONS_DROP' | 'ENDING_SOON';
export type GrowthCode = 'TEACHERS_LIMIT' | 'STUDENTS_LIMIT' | 'STORAGE_LIMIT' | 'TRIAL_ENGAGED';
/** `value`: days for INACTIVE and ENDING_SOON, percent for SESSIONS_DROP and the limits, sessions for TRIAL_ENGAGED. */
export type Signal<C> = { code: C; value?: number };

export type Health = {
  risk: Signal<RiskCode>[];
  severity: 'high' | 'medium' | null;
  growth: Signal<GrowthCode>[];
};

const days = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY_MS);
const share = (u: Usage) => (u.max > 0 ? u.used / u.max : 0);

/** Assesses a center whose subscription is running (callers leave out lapsed and suspended ones). */
export function assessHealth(c: HealthInput, now = new Date()): Health {
  const age = days(c.createdAt, now);
  const trialing = c.subscription?.status === 'TRIALING';
  const risk: Signal<RiskCode>[] = [];

  if (c.subscription?.status === 'PAST_DUE') risk.push({ code: 'PAST_DUE' });
  if (!c.lastActiveAt) {
    if (age >= HEALTH.graceDays) risk.push({ code: 'NEVER_ACTIVE' });
  } else if (days(c.lastActiveAt, now) >= HEALTH.inactiveDays) {
    risk.push({ code: 'INACTIVE', value: days(c.lastActiveAt, now) });
  }
  if (trialing) {
    if (age >= HEALTH.trialStalledDays && (c.students.used === 0 || c.sessions30 === 0)) risk.push({ code: 'TRIAL_STALLED' });
  } else if (c.sessions30 === 0) {
    if (age >= HEALTH.inactiveDays) risk.push({ code: 'NO_SESSIONS' });
  } else if (c.sessionsPrev30 >= HEALTH.dropMinPrevious && c.sessions30 < c.sessionsPrev30 * HEALTH.dropRatio) {
    risk.push({ code: 'SESSIONS_DROP', value: Math.round((1 - c.sessions30 / c.sessionsPrev30) * 100) });
  }
  // A period about to end is only a risk next to another warning sign; alone it is a renewal.
  // Trials always end soon, so it says nothing about them.
  const end = c.subscription?.periodEnd;
  const endsIn = end ? Math.ceil((end.getTime() - now.getTime()) / DAY_MS) : null;
  const ending = !trialing && endsIn !== null && endsIn >= 0 && endsIn <= HEALTH.endingDays;
  if (risk.length && ending) risk.push({ code: 'ENDING_SOON', value: endsIn });

  const severity = !risk.length ? null : risk.some((r) => r.code === 'PAST_DUE' || r.code === 'ENDING_SOON') || risk.length >= 2 ? 'high' : 'medium';

  const growth: Signal<GrowthCode>[] = [];
  const limits: [GrowthCode, Usage][] = [
    ['TEACHERS_LIMIT', c.teachers],
    ['STUDENTS_LIMIT', c.students],
    ['STORAGE_LIMIT', c.storage],
  ];
  for (const [code, u] of limits) {
    if (share(u) >= HEALTH.limitRatio) growth.push({ code, value: Math.round(share(u) * 100) });
  }
  if (trialing && c.sessions30 >= HEALTH.engagedTrialSessions) growth.push({ code: 'TRIAL_ENGAGED', value: c.sessions30 });

  return { risk, severity, growth };
}
