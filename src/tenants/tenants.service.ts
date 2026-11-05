import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from '../auth/auth.service.js';
import { unusablePassword } from '../auth/passwords.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { Locale } from '../i18n/locale.js';
import type { BulkPlatformFeeDto, CreateTenantByAdminDto, UpdateSubscriptionDto, UpdateTenantDto } from './dto/tenant.dto.js';
import { SubscriptionAccess } from './subscription.guard.js';
import { isExpired } from './subscription.js';
import { recordSubscriptionChange } from './subscription-history.js';
import { msg } from '../i18n/i18n.js';
import { NotificationEvents } from '../notifications/notification-events.js';
import { effectivePlatformFee } from '../billing/billing.js';

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const DAY_MS = 24 * 60 * 60 * 1000;

/** The center's owner: its first admin membership. */
const ownerSelect = {
  where: { role: 'TENANT_ADMIN' as const },
  orderBy: { createdAt: 'asc' as const },
  take: 1,
  select: { user: { select: { fullName: true, email: true, lastLoginAt: true } } },
};

/** Prisma Decimal → number, keeping null. */
const percentOf = (d: { toString(): string } | null | undefined) => (d == null ? null : Number(d));

/**
 * The platform's fee on a center as the console shows it: what applies (its own percentage, else
 * its package's), and the center's own override (null = it follows the package).
 */
function platformFee(t: { platformFeePercent: { toString(): string } | null; subscription: { plan: { platformFeePercent: { toString(): string } | null } } | null }) {
  const own = percentOf(t.platformFeePercent);
  return { platformFeePercent: effectivePlatformFee(own, percentOf(t.subscription?.plan.platformFeePercent)), platformFeeOverride: own };
}

function isTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SubscriptionAccess,
    private readonly auth: AuthService,
    private readonly events: NotificationEvents,
  ) {}

  async me(tenantId: string) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      include: { subscription: { include: { plan: true } } },
    });
    return { ...tenant, subscriptionExpired: isExpired(tenant.subscription) };
  }

  async updateMe(tenantId: string, dto: UpdateTenantDto) {
    if (dto.timezone !== undefined && !isTimeZone(dto.timezone)) {
      throw new BadRequestException(msg('tenants.invalidTimezone'));
    }
    const currency = dto.currency?.toUpperCase();
    if (currency !== undefined && !CURRENCIES.has(currency)) {
      throw new BadRequestException(msg('tenants.invalidCurrency'));
    }
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { name: dto.name?.trim(), timezone: dto.timezone, currency, chargeAbsent: dto.chargeAbsent },
    });
    return this.me(tenantId);
  }

  async stats(user: JwtUser) {
    const tenantId = user.tenantId!;
    const now = new Date();
    const teacherFilter = user.role === 'TEACHER' && user.teacherId ? { teacherId: user.teacherId } : {};

    const [teachers, students, courses, upcomingSessions, openExams] = await Promise.all([
      this.prisma.teacher.count({ where: { tenantId } }),
      user.role === 'TEACHER' && user.teacherId
        ? this.prisma.teacherStudent.count({ where: { teacherId: user.teacherId } })
        : this.prisma.student.count({ where: { tenantId } }),
      this.prisma.course.count({ where: { tenantId, isActive: true, ...teacherFilter } }),
      this.prisma.session.count({ where: { tenantId, status: 'SCHEDULED', startAt: { gte: now }, ...teacherFilter } }),
      this.prisma.exam.count({ where: { tenantId, status: 'PUBLISHED', ...teacherFilter } }),
    ]);

    return { teachers, students, courses, upcomingSessions, openExams };
  }

  /** Super admin: every center with its owner, package, period, size and storage. */
  async listAll() {
    const [rows, storage] = await Promise.all([
      this.prisma.tenant.findMany({
        include: {
          subscription: {
            include: { plan: { select: { id: true, code: true, nameAr: true, nameEn: true, maxTeachers: true, maxStudents: true, platformFeePercent: true } } },
          },
          memberships: ownerSelect,
          _count: { select: { memberships: true, teachers: true, students: true, courses: true, sessions: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.storageByTenant(),
    ]);
    return rows.map(({ memberships, ...t }) => ({
      ...t,
      ...platformFee(t),
      owner: memberships[0]?.user ?? null,
      storageBytes: storage.get(t.id) ?? 0,
      subscriptionExpired: isExpired(t.subscription),
    }));
  }

  /**
   * Super admin: sets up a center with its package and owner. An email that already has an account
   * gets the center added to it; a new one gets an account and a welcome email to choose a password.
   */
  async create(dto: CreateTenantByAdminDto, actorId: string, locale?: Locale) {
    if (await this.prisma.tenant.findUnique({ where: { slug: dto.slug }, select: { id: true } })) {
      throw new ConflictException(msg('auth.slugTaken'));
    }
    if (dto.timezone !== undefined && !isTimeZone(dto.timezone)) throw new BadRequestException(msg('tenants.invalidTimezone'));
    const currency = dto.currency?.toUpperCase();
    if (currency !== undefined && !CURRENCIES.has(currency)) throw new BadRequestException(msg('tenants.invalidCurrency'));
    const plan = await this.prisma.plan.findUnique({ where: { id: dto.planId }, select: { isActive: true } });
    if (!plan) throw new NotFoundException(msg('plans.notFound'));
    if (!plan.isActive) throw new BadRequestException(msg('tenants.planInactive'));

    const email = dto.ownerEmail.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    const passwordHash = existing ? null : await bcrypt.hash(unusablePassword(), 10);
    const { tenantId, membershipId } = await this.prisma.$transaction(async (tx) => {
      const userId =
        existing?.id ??
        (await tx.user.create({ data: { email, passwordHash: passwordHash!, fullName: dto.ownerName.trim(), phone: dto.ownerPhone?.trim() || null }, select: { id: true } }))
          .id;
      const tenant = await tx.tenant.create({
        data: {
          name: dto.name.trim(),
          slug: dto.slug,
          timezone: dto.timezone,
          currency,
          subscription: { create: { planId: dto.planId, status: dto.status, currentPeriodEnd: dto.currentPeriodEnd ? new Date(dto.currentPeriodEnd) : null } },
        },
        select: { id: true },
      });
      await recordSubscriptionChange(tx, tenant.id, actorId);
      const membership = await tx.membership.create({ data: { userId, tenantId: tenant.id, role: 'TENANT_ADMIN' }, select: { id: true } });
      if (!existing) await tx.user.update({ where: { id: userId }, data: { lastMembershipId: membership.id } });
      return { tenantId: tenant.id, membershipId: membership.id };
    });
    await this.auth.sendWelcome(membershipId, { existingAccount: Boolean(existing) }, locale);
    return (await this.listAll()).find((t) => t.id === tenantId);
  }

  /** Super admin: the platform's fee on one center (null = follow its package, 0 = none). */
  async setPlatformFee(id: string, percent: number | null) {
    await this.getTenant(id);
    const t = await this.prisma.tenant.update({
      where: { id },
      data: { platformFeePercent: percent },
      select: { id: true, platformFeePercent: true, subscription: { select: { plan: { select: { platformFeePercent: true } } } } },
    });
    return { id: t.id, ...platformFee(t) };
  }

  /**
   * Super admin: the same fee on a chosen set of centers, or on every center except some (null = back to their packages').
   * Returns how many were changed.
   */
  async bulkPlatformFee(dto: BulkPlatformFeeDto) {
    const ids = dto.tenantIds && [...new Set(dto.tenantIds)];
    const except = dto.except ?? [];
    if (ids && ids.length === 0) throw new BadRequestException(msg('tenants.platformFeeNoTargets'));
    const where = ids ? { id: { in: ids.filter((id) => !except.includes(id)) } } : except.length ? { id: { notIn: except } } : {};
    const res = await this.prisma.tenant.updateMany({ where, data: { platformFeePercent: dto.percent } });
    return { updated: res.count, percent: dto.percent };
  }

  /** Super admin: the platform at a glance and what needs attention soon. */
  async overview() {
    const now = new Date();
    const soon = new Date(now.getTime() + 14 * DAY_MS);
    const since30 = new Date(now.getTime() - 30 * DAY_MS);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [tenants, suspended, newThisMonth, subsByStatus, expired, users, membersByRole, sessions30, upcoming, storage, expiringSoon, recent] =
      await Promise.all([
        this.prisma.tenant.count(),
        this.prisma.tenant.count({ where: { status: 'SUSPENDED' } }),
        this.prisma.tenant.count({ where: { createdAt: { gte: monthStart } } }),
        this.prisma.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.subscription.count({ where: { currentPeriodEnd: { lt: now } } }),
        this.prisma.user.count({ where: { isPlatformAdmin: false } }),
        this.prisma.membership.groupBy({ by: ['role'], _count: { _all: true } }),
        this.prisma.session.count({ where: { startAt: { gte: since30, lte: now } } }),
        this.prisma.session.count({ where: { status: 'SCHEDULED', startAt: { gte: now } } }),
        this.prisma.storedBlob.aggregate({ where: { files: { some: {} } }, _sum: { size: true } }),
        this.prisma.tenant.findMany({
          where: { status: 'ACTIVE', subscription: { currentPeriodEnd: { gte: now, lte: soon } } },
          select: {
            id: true,
            name: true,
            slug: true,
            subscription: { select: { status: true, currentPeriodEnd: true, plan: { select: { nameAr: true, nameEn: true } } } },
          },
          orderBy: { subscription: { currentPeriodEnd: 'asc' } },
          take: 8,
        }),
        this.prisma.tenant.findMany({
          orderBy: { createdAt: 'desc' },
          take: 8,
          select: { id: true, name: true, slug: true, createdAt: true, memberships: ownerSelect },
        }),
      ]);
    const subs = (status: string) => subsByStatus.find((s) => s.status === status)?._count._all ?? 0;
    const members = (role: string) => membersByRole.find((m) => m.role === role)?._count._all ?? 0;
    return {
      tenants: { total: tenants, active: tenants - suspended, suspended, newThisMonth },
      subscriptions: { trialing: subs('TRIALING'), active: subs('ACTIVE'), pastDue: subs('PAST_DUE'), canceled: subs('CANCELED'), expired },
      members: { users, admins: members('TENANT_ADMIN'), teachers: members('TEACHER'), students: members('STUDENT') },
      sessions: { last30Days: sessions30, upcoming },
      storageBytes: storage._sum.size ?? 0,
      expiringSoon: expiringSoon.map((t) => ({ id: t.id, name: t.name, slug: t.slug, ...t.subscription! })),
      recent: recent.map(({ memberships, ...t }) => ({ ...t, owner: memberships[0]?.user ?? null })),
    };
  }

  /** Super admin: one center in depth — subscription against its limits, members, activity, integrations. */
  async detail(id: string) {
    const now = new Date();
    const since30 = new Date(now.getTime() - 30 * DAY_MS);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        subscription: { include: { plan: true } },
        memberships: {
          orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            role: true,
            status: true,
            statusReason: true,
            createdAt: true,
            user: { select: { id: true, fullName: true, email: true, lastLoginAt: true } },
          },
        },
        integrations: { select: { provider: true, user: { select: { fullName: true } } } },
        _count: { select: { teachers: true, students: true, courses: true, exams: true, sessions: true } },
      },
    });
    if (!tenant) throw new NotFoundException(msg('tenants.notFound'));
    const [byStatus, sessions30, storage] = await Promise.all([
      this.prisma.session.groupBy({ by: ['status'], where: { tenantId: id }, _count: { _all: true } }),
      this.prisma.session.count({ where: { tenantId: id, startAt: { gte: since30, lte: now } } }),
      this.prisma.storedBlob.aggregate({ where: { tenantId: id, files: { some: {} } }, _sum: { size: true } }),
    ]);
    const { subscription, memberships, integrations, _count, ...rest } = tenant;
    const logins = memberships.map((m) => m.user.lastLoginAt?.getTime() ?? 0);
    const lastLoginAt = logins.length ? new Date(Math.max(...logins)) : null;
    return {
      ...rest,
      ...platformFee({ ...rest, subscription }),
      subscriptionExpired: isExpired(subscription),
      subscription: subscription && {
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        plan: {
          id: subscription.plan.id,
          code: subscription.plan.code,
          nameAr: subscription.plan.nameAr,
          nameEn: subscription.plan.nameEn,
          maxTeachers: subscription.plan.maxTeachers,
          maxStudents: subscription.plan.maxStudents,
          storagePerTeacherMb: subscription.plan.storagePerTeacherMb,
          sharedStorageMb: subscription.plan.sharedStorageMb,
          maxFileMb: subscription.plan.maxFileMb,
          priceMonthly: subscription.plan.priceMonthly?.toString() ?? null,
          currency: subscription.plan.currency,
          platformFeePercent: percentOf(subscription.plan.platformFeePercent),
        },
      },
      members: memberships.map((m) => ({ id: m.id, role: m.role, status: m.status, statusReason: m.statusReason, joinedAt: m.createdAt, user: m.user })),
      integrations: integrations.map((i) => ({ provider: i.provider, user: i.user.fullName })),
      counts: _count,
      sessions: {
        last30Days: sessions30,
        byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])) as Partial<Record<string, number>>,
      },
      storageBytes: storage._sum.size ?? 0,
      lastLoginAt: lastLoginAt && lastLoginAt.getTime() > 0 ? lastLoginAt : null,
    };
  }

  /** Bytes in use per center (blobs some file still points at). */
  private async storageByTenant() {
    const rows = await this.prisma.storedBlob.groupBy({ by: ['tenantId'], where: { files: { some: {} } }, _sum: { size: true } });
    return new Map(rows.map((r) => [r.tenantId, r._sum.size ?? 0]));
  }

  async setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED') {
    await this.getTenant(id);
    return this.prisma.tenant.update({ where: { id }, data: { status } });
  }

  /**
   * Super admin: switch package, status or end date; creates the subscription if the center has none.
   * Every change is appended to the center's subscription history.
   */
  async updateSubscription(id: string, dto: UpdateSubscriptionDto, actorId: string | null = null) {
    await this.getTenant(id);
    if (dto.planId) {
      const plan = await this.prisma.plan.findUnique({ where: { id: dto.planId } });
      if (!plan) throw new NotFoundException(msg('plans.notFound'));
    }
    // undefined keeps the date, null removes it (no end), a string sets it.
    const end = dto.currentPeriodEnd === undefined ? undefined : dto.currentPeriodEnd === null ? null : new Date(dto.currentPeriodEnd);
    const existing = await this.prisma.subscription.findUnique({ where: { tenantId: id } });
    if (!existing && (!dto.planId || end === undefined)) throw new BadRequestException(msg('tenants.subscriptionNeedsPlan'));

    await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.subscription.update({
          where: { tenantId: id },
          data: { planId: dto.planId, status: dto.status, currentPeriodEnd: end },
        });
      } else {
        await tx.subscription.create({
          data: { tenantId: id, planId: dto.planId!, status: dto.status ?? 'ACTIVE', currentPeriodEnd: end ?? null },
        });
      }
      await recordSubscriptionChange(tx, id, actorId);
    });
    this.access.forget(id);
    void this.events.subscriptionChanged(id, actorId);
    return (await this.listAll()).find((t) => t.id === id);
  }

  private async getTenant(id: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundException(msg('tenants.notFound'));
    return tenant;
  }
}
