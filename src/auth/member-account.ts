import { ConflictException, ForbiddenException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import type { Prisma } from '../generated/prisma/client.js';
import type { Role } from '../generated/prisma/enums.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import { msg, type MessageKey } from '../i18n/i18n.js';

/**
 * A member's sign-in email and password belong to their account, which may be in other centers
 * too. The center that manages a teacher or student may still change them (to fix a mistyped
 * email, or set a password the member forgot) while the account is that center's alone. Otherwise
 * the owner changes them in their own settings. This says why it can't, or null when it can.
 *
 * - `support`: support mode never changes how someone signs in.
 * - `self`: the editor's own account (their settings ask for the current password).
 * - `admin`: the center's admins, never changed by another member.
 * - `shared`: the account is in other centers too, or is a platform operator.
 */
export type AccountLock = 'support' | 'self' | 'admin' | 'shared';

export function accountLock(
  account: { userId: string; role: Role; centers: number; isPlatformAdmin: boolean },
  editor: Pick<JwtUser, 'id' | 'supportSessionId'>,
): AccountLock | null {
  if (editor.supportSessionId) return 'support';
  if (account.userId === editor.id) return 'self';
  if (account.role !== 'TEACHER' && account.role !== 'STUDENT') return 'admin';
  if (account.isPlatformAdmin || account.centers > 1) return 'shared';
  return null;
}

const LOCK_MESSAGE: Record<AccountLock, MessageKey> = {
  support: 'support.notAllowed',
  self: 'users.accountOwnSettings',
  admin: 'users.accountOfAdmin',
  shared: 'users.accountShared',
};

/** Selected with a member's `user`, so `lockOf` can tell whether the center may change the account. */
export const accountFacts = { isPlatformAdmin: true, _count: { select: { memberships: true } } } as const;

type AccountRow = {
  user: { id: string; email: string; isPlatformAdmin: boolean; _count: { memberships: number } };
  membership: { role: Role };
};

export const lockOf = (row: AccountRow, editor: Pick<JwtUser, 'id' | 'supportSessionId'>) =>
  accountLock(
    { userId: row.user.id, role: row.membership.role, centers: row.user._count.memberships, isPlatformAdmin: row.user.isPlatformAdmin },
    editor,
  );

/** The row as the API returns it: the account facts become `accountLock`. */
export function presentMember<R extends AccountRow>(row: R, editor: Pick<JwtUser, 'id' | 'supportSessionId'>) {
  const { isPlatformAdmin: _p, _count: _c, ...user } = row.user;
  return { ...row, user, accountLock: lockOf(row, editor) };
}

type Db = Pick<Prisma.TransactionClient, 'user'>;

/**
 * The `user` fields to write for a new email or password. A value equal to the current one (forms
 * send the email back unchanged) or left out changes nothing and needs no permission.
 */
export async function accountChanges(
  db: Db,
  row: AccountRow,
  editor: Pick<JwtUser, 'id' | 'supportSessionId'>,
  dto: { email?: string; password?: string },
): Promise<{ email?: string; passwordHash?: string }> {
  const email = dto.email?.trim().toLowerCase();
  const changes: { email?: string; passwordHash?: string } = {};
  if (email && email !== row.user.email) changes.email = email;
  if (dto.password) changes.passwordHash = await bcrypt.hash(dto.password, 10);
  if (!changes.email && !changes.passwordHash) return changes;

  const lock = lockOf(row, editor);
  if (lock) throw new ForbiddenException(msg(LOCK_MESSAGE[lock]));
  if (changes.email) {
    const taken = await db.user.findUnique({ where: { email: changes.email }, select: { id: true } });
    if (taken) throw new ConflictException(msg('users.emailInUse'));
  }
  return changes;
}

type AfterDb = Pick<Prisma.TransactionClient, 'refreshToken' | 'passwordResetToken'>;

/**
 * After saving: a new password signs the member out everywhere; a new email voids the password
 * links sent to the old one. Returns whether the member never signed in (then the welcome email
 * should go again, to the new address: the first one most likely went to the mistyped email).
 */
export async function afterAccountChange(db: AfterDb, userId: string, changes: { email?: string; passwordHash?: string }) {
  const now = new Date();
  if (changes.passwordHash) {
    await db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  }
  if (!changes.email) return { resendWelcome: false };
  await db.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
  const signedIn = await db.refreshToken.count({ where: { userId } });
  return { resendWelcome: signedIn === 0 && !changes.passwordHash };
}
