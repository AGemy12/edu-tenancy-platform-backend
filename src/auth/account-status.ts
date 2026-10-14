import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Prisma } from '../generated/prisma/client.js';
import type { AccountStatus } from '../generated/prisma/enums.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import { msg } from '../i18n/i18n.js';

/**
 * Member accounts have three states. ACTIVE is normal. SUSPENDED members still sign in and read
 * everything, but every write is refused, so a teacher can't create, start or evaluate sessions
 * and a student can't join one. BLOCKED members can't sign in at all; blocking also ends their
 * open sessions. The admin sets this for teachers and students; a teacher for their own students.
 */

const ALLOW_SUSPENDED_KEY = 'allowSuspended';
/** Lets a suspended member through a write (their own profile, password, signing out). */
export const AllowSuspended = () => SetMetadata(ALLOW_SUSPENDED_KEY, true);

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Runs after the auth and role guards: refuses writes from suspended members. */
@Injectable()
export class AccountStatusGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<{ method: string; user?: JwtUser }>();
    if (req.user?.status !== 'SUSPENDED' || READS.has(req.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_SUSPENDED_KEY, [ctx.getHandler(), ctx.getClass()])) return true;
    throw new ForbiddenException(msg('auth.suspended'));
  }
}

type Db = Pick<Prisma.TransactionClient, 'user' | 'membership' | 'refreshToken'>;

/**
 * Records the new status of one membership (and who set it, and why). Blocking ends that
 * center's sessions; the same person's other centers are untouched.
 */
export async function setAccountStatus(
  db: Db,
  membershipId: string,
  change: { status: AccountStatus; reason?: string | null },
  byUserId: string,
) {
  const now = new Date();
  await db.membership.update({
    where: { id: membershipId },
    data: {
      status: change.status,
      statusReason: change.status === 'ACTIVE' ? null : (change.reason?.trim() || null),
      statusChangedAt: now,
      statusChangedById: byUserId,
    },
  });
  if (change.status === 'BLOCKED') {
    await db.refreshToken.updateMany({ where: { membershipId, revokedAt: null }, data: { revokedAt: now } });
  }
}

/**
 * Takes a member out of a center (their teacher or student profile goes with the membership).
 * The sign-in itself is deleted only when it belongs to no other center.
 */
export async function removeMembership(db: Db, membershipId: string) {
  const m = await db.membership.findUniqueOrThrow({
    where: { id: membershipId },
    select: { userId: true, user: { select: { isPlatformAdmin: true, _count: { select: { memberships: true } } } } },
  });
  await db.membership.delete({ where: { id: membershipId } });
  if (m.user._count.memberships === 1 && !m.user.isPlatformAdmin) {
    await db.user.delete({ where: { id: m.userId } });
  }
}
