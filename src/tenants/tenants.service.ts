import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { UpdateSubscriptionDto, UpdateTenantDto } from './dto/tenant.dto.js';
import { SubscriptionAccess } from './subscription.guard.js';
import { isExpired } from './subscription.js';
import { msg } from '../i18n/i18n.js';

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const DAY_MS = 24 * 60 * 60 * 1000;

/** The center's owner: its first admin membership. */
const ownerSelect = {
  where: { role: 'TENANT_ADMIN' as const },
  orderBy: { createdAt: 'asc' as const },
  take: 1,
  select: { user: { select: { fullName: true, email: true, lastLoginAt: true } } },
};

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
      data: { name: dto.name?.trim(), timezone: dto.timezone, currency },
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
          subscription: { include: { plan: { select: { id: true, code: true, nameAr: true, nameEn: true, maxTeachers: true, maxStudents: true } } } },
          memberships: ownerSelect,
          _count: { select: { memberships: true, teachers: true, students: true, courses: true, sessions: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.storageByTenant(),
    ]);
    return rows.map(({ memberships, ...t }) => ({
      ...t,
      owner: memberships[0]?.user ?? null,
      storageBytes: storage.get(t.id) ?? 0,
      subscriptionExpired: isExpired(t.subscription),
    }));
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

  /** Super admin: switch package, status or end date; creates the subscription if the center has none. */
  async updateSubscription(id: string, dto: UpdateSubscriptionDto) {
    await this.getTenant(id);
    if (dto.planId) {
      const plan = await this.prisma.plan.findUnique({ where: { id: dto.planId } });
      if (!plan) throw new NotFoundException(msg('plans.notFound'));
    }
    // undefined keeps the date, null removes it (no end), a string sets it.
    const end = dto.currentPeriodEnd === undefined ? undefined : dto.currentPeriodEnd === null ? null : new Date(dto.currentPeriodEnd);
    const existing = await this.prisma.subscription.findUnique({ where: { tenantId: id } });
    if (!existing && (!dto.planId || end === undefined)) throw new BadRequestException(msg('tenants.subscriptionNeedsPlan'));

    if (existing) {
      await this.prisma.subscription.update({
        where: { tenantId: id },
        data: { planId: dto.planId, status: dto.status, currentPeriodEnd: end },
      });
    } else {
      await this.prisma.subscription.create({
        data: { tenantId: id, planId: dto.planId!, status: dto.status ?? 'ACTIVE', currentPeriodEnd: end ?? null },
      });
    }
    this.access.forget(id);
    return (await this.listAll()).find((t) => t.id === id);
  }

  private async getTenant(id: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundException(msg('tenants.notFound'));
    return tenant;
  }
}
