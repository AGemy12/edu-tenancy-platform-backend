/**
 * Storage entitlements, as pure functions (no database) so the rules are easy to test.
 *
 * - Every library member (teacher or center admin) gets the package's `storagePerTeacherMb`
 *   unless the admin set a custom allocation (`storageQuotaMb`).
 * - The admin may only redistribute: the sum of base allocations can't exceed
 *   `storagePerTeacherMb × members` (the "pool"). Extra space comes from add-ons.
 * - Add-ons (purchases or grants) add space on top, for one member or the center library.
 */

export const MB = 1024 * 1024;

export type PlanLimits = { storagePerTeacherMb: number; sharedStorageMb: number; maxFileMb: number };
export type AddOn = { userId: string | null; extraMb: number; startsAt: Date; expiresAt: Date | null };
export type Member = { id: string; storageQuotaMb: number | null };

export const isActiveAddOn = (a: AddOn, now = new Date()) => a.startsAt <= now && (!a.expiresAt || a.expiresAt > now);

/** Active extra MB for a member, or for the center library when `userId` is null. */
export function addOnMb(addOns: AddOn[], userId: string | null, now = new Date()) {
  return addOns.filter((a) => a.userId === userId && isActiveAddOn(a, now)).reduce((sum, a) => sum + a.extraMb, 0);
}

export const baseQuotaMb = (plan: PlanLimits, member: Pick<Member, 'storageQuotaMb'>) =>
  member.storageQuotaMb ?? plan.storagePerTeacherMb;

export const poolMb = (plan: PlanLimits, memberCount: number) => plan.storagePerTeacherMb * memberCount;

export const allocatedMb = (plan: PlanLimits, members: Member[]) =>
  members.reduce((sum, m) => sum + baseQuotaMb(plan, m), 0);

/** The most a member's base allocation can be without exceeding the pool. */
export function maxAllocationMb(plan: PlanLimits, members: Member[], memberId: string) {
  const others = allocatedMb(plan, members.filter((m) => m.id !== memberId));
  return Math.max(0, poolMb(plan, members.length) - others);
}

export function personalQuotaBytes(plan: PlanLimits, member: Member, addOns: AddOn[], now = new Date()) {
  return (baseQuotaMb(plan, member) + addOnMb(addOns, member.id, now)) * MB;
}

export function sharedQuotaBytes(plan: PlanLimits, addOns: AddOn[], now = new Date()) {
  return (plan.sharedStorageMb + addOnMb(addOns, null, now)) * MB;
}

/** "512 MB", "5 GB", "1.5 GB" — for messages. */
export function formatMb(mb: number) {
  if (mb < 1024) return `${mb} MB`;
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}
