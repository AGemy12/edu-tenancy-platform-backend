import { ForbiddenException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlansService } from '../plans/plans.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { Plan, Prisma } from '../generated/prisma/client.js';
import { msg } from '../i18n/i18n.js';
import { MB, formatMb, personalQuotaBytes, sharedQuotaBytes, type AddOn } from './quota.js';

/** Users who own a personal library: teachers and the center admin(s). */
export const LIBRARY_MEMBER_ROLES = ['TENANT_ADMIN', 'TEACHER'] as const;

@Injectable()
export class QuotaService {
  /** Absolute ceiling (also enforced by multer); packages set lower per-file limits. */
  readonly hardMaxFileBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    config: ConfigService,
  ) {
    this.hardMaxFileBytes = Number(config.get('LIBRARY_MAX_FILE_MB') ?? 1024) * MB;
  }

  plan(tenantId: string) {
    return this.plans.forTenant(tenantId);
  }

  addOns(tenantId: string): Promise<AddOn[]> {
    return this.prisma.storageAddOn.findMany({
      where: { tenantId },
      select: { userId: true, extraMb: true, startsAt: true, expiresAt: true },
    });
  }

  maxFileBytes(plan: Plan) {
    return Math.min(plan.maxFileMb * MB, this.hardMaxFileBytes);
  }

  /** Bytes charged to a member, or to the center library when `chargedToId` is null. Blobs no file uses don't count. */
  async usedBytes(tenantId: string, chargedToId: string | null) {
    const agg = await this.prisma.storedBlob.aggregate({
      where: { tenantId, chargedToId, files: { some: {} } },
      _sum: { size: true },
    });
    return agg._sum.size ?? 0;
  }

  async personal(tenantId: string, userId: string, plan?: Plan, addOns?: AddOn[]) {
    const [p, a, member, usedBytes] = await Promise.all([
      plan ?? this.plan(tenantId),
      addOns ?? this.addOns(tenantId),
      this.prisma.membership.findFirstOrThrow({ where: { userId, tenantId }, select: { userId: true, storageQuotaMb: true } }).then((m) => ({ id: m.userId, storageQuotaMb: m.storageQuotaMb })),
      this.usedBytes(tenantId, userId),
    ]);
    return { usedBytes, quotaBytes: personalQuotaBytes(p, member, a) };
  }

  async shared(tenantId: string, plan?: Plan, addOns?: AddOn[]) {
    const [p, a, usedBytes] = await Promise.all([plan ?? this.plan(tenantId), addOns ?? this.addOns(tenantId), this.usedBytes(tenantId, null)]);
    return { usedBytes, quotaBytes: sharedQuotaBytes(p, a) };
  }

  /** The admin always can; a teacher needs the admin's permission. */
  async canManageShared(user: JwtUser) {
    if (user.role === 'TENANT_ADMIN' || user.role === 'SUPER_ADMIN') return true;
    if (user.role !== 'TEACHER' || !user.teacherId) return false;
    const teacher = await this.prisma.teacher.findUnique({ where: { id: user.teacherId }, select: { canManageSharedLibrary: true } });
    return Boolean(teacher?.canManageSharedLibrary);
  }

  async assertCanManageShared(user: JwtUser) {
    if (!(await this.canManageShared(user))) throw new ForbiddenException(msg('library.sharedForbidden'));
  }

  /**
   * Checks the package's per-file limit and the quota that will pay for `size` bytes:
   * the uploader's personal quota, or the center library's when `chargedToId` is null.
   */
  async assertCanStore(tenantId: string, chargedToId: string | null, size: number) {
    const plan = await this.plan(tenantId);
    const maxFile = this.maxFileBytes(plan);
    if (size > maxFile) throw new PayloadTooLargeException(msg('library.fileTooLargeForPlan', { max: formatMb(maxFile / MB) }));

    const bucket = chargedToId ? await this.personal(tenantId, chargedToId, plan) : await this.shared(tenantId, plan);
    if (bucket.usedBytes + size > bucket.quotaBytes) {
      const quota = formatMb(Math.round(bucket.quotaBytes / MB));
      throw new PayloadTooLargeException(
        chargedToId ? msg('library.personalStorageFull', { quota }) : msg('library.sharedStorageFull', { quota }),
      );
    }
  }

  /** The center's library members (admins and teachers), keyed by user id since blobs are charged to users. */
  async members(tenantId: string) {
    const rows = await this.prisma.membership.findMany({
      where: { tenantId, role: { in: [...LIBRARY_MEMBER_ROLES] } } satisfies Prisma.MembershipWhereInput,
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        storageQuotaMb: true,
        user: { select: { fullName: true, email: true } },
        teacher: { select: { id: true, canManageSharedLibrary: true } },
      },
      orderBy: [{ role: 'asc' }, { user: { fullName: 'asc' } }],
    });
    return rows.map((m) => ({
      id: m.userId,
      membershipId: m.id,
      fullName: m.user.fullName,
      email: m.user.email,
      role: m.role,
      status: m.status,
      storageQuotaMb: m.storageQuotaMb,
      teacher: m.teacher,
    }));
  }
}
