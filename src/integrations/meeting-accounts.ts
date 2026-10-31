import type { IntegrationProvider } from '../generated/prisma/enums.js';

/**
 * Who links a meeting account, and which one a session needs. Pure rules (unit-tested).
 *
 * A Zoom or Google Meet session is always created on its teacher's own account (their licence,
 * their recordings), never the admin's who booked it. So only a member who teaches in the center
 * links one; an admin without a teacher profile has nothing to link. The link belongs to the
 * person (`Integration.userId`), so a teacher in two centers links once.
 */

/** The account each self-hosted session provider runs on. */
export const MEETING_ACCOUNT = { ZOOM: 'ZOOM', GOOGLE_MEET: 'GOOGLE' } as const satisfies Record<string, IntegrationProvider>;
export type HostedProvider = keyof typeof MEETING_ACCOUNT;

export const canLinkMeetingAccount = (user: { teacherId: string | null }) => Boolean(user.teacherId);

/** What an admin sees per teacher: which of the accounts sessions need are linked. */
export function linkedAccounts(providers: readonly IntegrationProvider[]) {
  return { zoom: providers.includes('ZOOM'), google: providers.includes('GOOGLE') };
}
