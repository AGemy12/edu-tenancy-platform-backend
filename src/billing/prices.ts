import type { RateBasis } from '../generated/prisma/enums.js';

/**
 * How a change of price is written. The center only ever sees one value per price (a course's
 * session price, a special price, a teacher's pay, the default price), but the rows keep history
 * so a session is always billed at the price in effect when it started:
 *
 * - The first value of a price applies to past sessions too, so sessions held before it was set
 *   aren't left unpriced. A special price is the exception: a discount starts now.
 * - Changing a price that no charged session has used yet corrects it in place (a typo stays a typo).
 * - Changing one that sessions were billed at adds a row from now on, so those sessions keep theirs.
 * - Removing a price works the same way, with a `cleared` row ending it; a price that was never
 *   used and has nothing before it is simply deleted.
 */

export type RateValue = { basis: RateBasis; amount: number };

export type StoredRate = { id: string; basis: RateBasis; amount: number; cleared: boolean; effectiveFrom: Date };

export type RateWrite =
  | { op: 'none' }
  | { op: 'insert'; effectiveFrom: Date; value: RateValue | null }
  | { op: 'update'; id: string; value: RateValue | null }
  | { op: 'delete'; id: string };

/** Since when a first value applies: from the beginning, or (a special price) from now. */
export const firstEffectiveFrom = (special: boolean, now: Date) => (special ? now : new Date(0));

const sameValue = (a: RateValue | null, b: RateValue | null) => (a === null || b === null ? a === b : a.basis === b.basis && a.amount === b.amount);

/** A scope's rows split around `now`: the one in effect, the one before it, and those that start later. */
export function splitRows(rows: StoredRate[], now: Date) {
  const started = rows.filter((r) => r.effectiveFrom.getTime() <= now.getTime()).sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  return {
    current: started[0] ?? null,
    previous: started[1] ?? null,
    future: rows.filter((r) => r.effectiveFrom.getTime() > now.getTime()),
  };
}

/**
 * What to write so the price becomes `value` (null = no price) from now on. `used` says whether a
 * charged session started while `current` was in effect.
 */
export function planRateWrite(input: {
  current: StoredRate | null;
  previous: StoredRate | null;
  used: boolean;
  value: RateValue | null;
  now: Date;
  special: boolean;
}): RateWrite {
  const { current, previous, used, value, now, special } = input;
  const currentValue = current && !current.cleared ? { basis: current.basis, amount: current.amount } : null;
  if (sameValue(currentValue, value)) return { op: 'none' };
  if (!current) return { op: 'insert', effectiveFrom: firstEffectiveFrom(special, now), value };
  if (used) return { op: 'insert', effectiveFrom: now, value };
  // Nobody was billed at the current row: correct it. Removing it outright is only safe when no
  // older price would take over again.
  if (value === null && !(previous && !previous.cleared)) return { op: 'delete', id: current.id };
  return { op: 'update', id: current.id, value };
}
