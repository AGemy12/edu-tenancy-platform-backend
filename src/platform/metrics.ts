import type { SubscriptionStatus } from '../generated/prisma/enums.js';

/**
 * Subscription metrics for the platform operator, replayed from each center's subscription
 * history (`SubscriptionChange`). Pure functions: the service loads the rows, these do the math.
 *
 * A center pays at an instant when its subscription is ACTIVE or PAST_DUE (late but not gone),
 * on a package with a price, and its period has not ended. Trials, free and canceled packages
 * and lapsed periods count as zero. Months are UTC calendar months.
 */

/** The subscription as it stood from `at` on. */
export type Change = { at: Date; status: SubscriptionStatus; periodEnd: Date | null; price: number; currency: string };

export type Revenue = { amount: number; currency: string };

const PAYING = new Set<SubscriptionStatus>(['ACTIVE', 'PAST_DUE']);
const DAY_MS = 24 * 60 * 60 * 1000;

/** The change in force at `t`; `history` is sorted oldest first. */
export function stateAt(history: Change[], t: Date): Change | null {
  let found: Change | null = null;
  for (const c of history) {
    if (c.at > t) break;
    found = c;
  }
  return found;
}

/** What the center pays per month at `t`, or null when it pays nothing. */
export function revenueAt(history: Change[], t: Date): Revenue | null {
  const c = stateAt(history, t);
  if (!c || !PAYING.has(c.status) || c.price <= 0) return null;
  if (c.periodEnd && c.periodEnd <= t) return null;
  return { amount: c.price, currency: c.currency };
}

/** First instants of the last `count` UTC months, oldest first, ending with the month of `now`. */
export function monthStarts(now: Date, count: number) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(y, m - (count - 1 - i), 1)));
}

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** One month of recurring revenue in one currency: where it started, where it ended and why. */
export type MrrMonth = {
  month: string; // YYYY-MM
  start: number;
  mrr: number; // at the end of the month (now, for the current month)
  new: number; // centers that started paying (or came back)
  expansion: number; // paying centers moved to a dearer package
  contraction: number; // paying centers moved to a cheaper one
  churned: number; // centers that stopped paying
  paying: number; // centers paying at the end
};

/** Centers (not money) per month, whatever the currency. */
export type LogoMonth = { month: string; start: number; paying: number; gained: number; lost: number };

/**
 * Monthly recurring revenue per currency for the last `count` months, with the movements that
 * explain each month: start + new + expansion − contraction − churned = mrr. A center that
 * switches currency counts as churned in the old one and new in the other.
 */
export function mrrByMonth(histories: Change[][], now: Date, count = 12) {
  const starts = monthStarts(now, count);
  const byCurrency = new Map<string, MrrMonth[]>();
  const logos: LogoMonth[] = [];
  const row = (currency: string, i: number) => {
    let months = byCurrency.get(currency);
    if (!months) {
      months = starts.map((s) => ({ month: monthKey(s), start: 0, mrr: 0, new: 0, expansion: 0, contraction: 0, churned: 0, paying: 0 }));
      byCurrency.set(currency, months);
    }
    return months[i];
  };

  starts.forEach((start, i) => {
    const next = starts[i + 1] ?? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const end = next < now ? next : now;
    const logo: LogoMonth = { month: monthKey(start), start: 0, paying: 0, gained: 0, lost: 0 };
    for (const h of histories) {
      const a = revenueAt(h, start);
      const b = revenueAt(h, end);
      if (a) {
        row(a.currency, i).start += a.amount;
        logo.start++;
      }
      if (b) {
        const r = row(b.currency, i);
        r.mrr += b.amount;
        r.paying++;
        logo.paying++;
      }
      if (a && b && a.currency === b.currency) {
        const diff = b.amount - a.amount;
        if (diff > 0) row(b.currency, i).expansion += diff;
        if (diff < 0) row(b.currency, i).contraction -= diff;
        continue;
      }
      if (a) row(a.currency, i).churned += a.amount;
      if (b) row(b.currency, i).new += b.amount;
      if (a && !b) logo.lost++;
      if (b && !a) logo.gained++;
    }
    logos.push(logo);
  });

  return { byCurrency, logos };
}

export type TrialFunnel = { windowDays: number; started: number; converted: number; lost: number; open: number; rate: number | null };

/**
 * Trials that started in the last `windowDays`: how many became paying, how many ended without
 * paying (period over, canceled, or moved to a free package), and how many are still running.
 * The rate counts decided trials only, so a burst of fresh sign-ups does not drag it down.
 */
export function trialFunnel(histories: Change[][], now: Date, windowDays = 90): TrialFunnel {
  const since = new Date(now.getTime() - windowDays * DAY_MS);
  const out: TrialFunnel = { windowDays, started: 0, converted: 0, lost: 0, open: 0, rate: null };
  for (const h of histories) {
    const i = h.findIndex((c) => c.status === 'TRIALING');
    if (i < 0 || h[i].at < since || h[i].at > now) continue;
    out.started++;
    const later = h.slice(i).filter((c) => c.at <= now);
    if (later.some((c) => revenueAt(h, c.at))) {
      out.converted++;
      continue;
    }
    const current = later[later.length - 1];
    const running = current.status === 'TRIALING' && (current.periodEnd === null || current.periodEnd > now);
    if (running) out.open++;
    else out.lost++;
  }
  const decided = out.converted + out.lost;
  out.rate = decided ? out.converted / decided : null;
  return out;
}
