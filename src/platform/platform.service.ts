import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { isExpired } from '../tenants/subscription.js';
import { MB, isActiveAddOn, poolMb } from '../library/quota.js';
import { HEALTH, assessHealth } from './health.js';
import { mrrByMonth, revenueAt, trialFunnel, type Change } from './metrics.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const STAFF = ['TENANT_ADMIN', 'TEACHER'] as const;

/** Super admin: how the platform's business is doing, and which centers need a call. */
@Injectable()
export class PlatformService {
  constructor(private readonly prisma: PrismaService) {}

  /** MRR per currency over the last `months`, churn and the trial funnel. */
  async metrics(months = 12, now = new Date()) {
    const rows = await this.prisma.subscriptionChange.findMany({
      select: { tenantId: true, status: true, currentPeriodEnd: true, priceMonthly: true, currency: true, createdAt: true },
      orderBy: [{ tenantId: 'asc' }, { createdAt: 'asc' }],
    });
    const byTenant = new Map<string, Change[]>();
    for (const r of rows) {
      const h = byTenant.get(r.tenantId) ?? [];
      h.push({ at: r.createdAt, status: r.status, periodEnd: r.currentPeriodEnd, price: Number(r.priceMonthly ?? 0), currency: r.currency });
      byTenant.set(r.tenantId, h);
    }
    const histories = [...byTenant.values()];
    const { byCurrency, logos } = mrrByMonth(histories, now, months);
    // The last full month: the current one is still running.
    const last = months - 2;

    const currencies = [...byCurrency.entries()]
      .map(([currency, m]) => {
        const current = m[m.length - 1];
        const prev = last >= 0 ? m[last] : null;
        return {
          currency,
          mrr: current.mrr,
          arr: current.mrr * 12,
          paying: current.paying,
          arpa: current.paying ? current.mrr / current.paying : 0,
          revenueChurn: prev && prev.start ? (prev.churned + prev.contraction) / prev.start : null,
          months: m,
        };
      })
      .sort((a, b) => b.mrr - a.mrr || a.currency.localeCompare(b.currency));
    const prevLogos = last >= 0 ? logos[last] : null;

    return {
      asOf: now,
      currencies,
      logos: {
        paying: logos[logos.length - 1]?.paying ?? 0,
        churn: prevLogos && prevLogos.start ? prevLogos.lost / prevLogos.start : null,
        months: logos,
      },
      trials: trialFunnel(histories, now),
    };
  }

  /** Running centers that show warning signs (risk) or are outgrowing their package (growth). */
  async health(now = new Date()) {
    const since30 = new Date(now.getTime() - 30 * DAY_MS);
    const since60 = new Date(now.getTime() - 60 * DAY_MS);
    const [tenants, recent, previous, storage, addOns, staff, tokens] = await Promise.all([
      this.prisma.tenant.findMany({
        where: { status: 'ACTIVE', subscription: { isNot: null } },
        select: {
          id: true,
          name: true,
          slug: true,
          createdAt: true,
          subscription: {
            select: {
              status: true,
              currentPeriodEnd: true,
              plan: {
                select: { nameAr: true, nameEn: true, priceMonthly: true, currency: true, maxTeachers: true, maxStudents: true, storagePerTeacherMb: true, sharedStorageMb: true, maxFileMb: true },
              },
            },
          },
          _count: { select: { teachers: true, students: true, memberships: { where: { role: { in: [...STAFF] } } } } },
        },
      }),
      this.sessionsByTenant(since30, now),
      this.sessionsByTenant(since60, since30),
      this.prisma.storedBlob.groupBy({ by: ['tenantId'], where: { files: { some: {} } }, _sum: { size: true } }),
      this.prisma.storageAddOn.findMany({ select: { tenantId: true, userId: true, extraMb: true, startsAt: true, expiresAt: true } }),
      this.prisma.membership.findMany({ where: { role: { in: [...STAFF] } }, select: { id: true, tenantId: true } }),
      this.prisma.refreshToken.groupBy({
        by: ['membershipId'],
        // Support sessions are the platform working inside the center, not the center's own activity.
        where: { membership: { role: { in: [...STAFF] } }, supportSessionId: null },
        _max: { createdAt: true },
      }),
    ]);

    const used = new Map(storage.map((s) => [s.tenantId, s._sum.size ?? 0]));
    const extraMb = new Map<string, number>();
    for (const a of addOns) if (isActiveAddOn(a, now)) extraMb.set(a.tenantId, (extraMb.get(a.tenantId) ?? 0) + a.extraMb);
    const tenantOf = new Map(staff.map((m) => [m.id, m.tenantId]));
    const lastActive = new Map<string, Date>();
    for (const t of tokens) {
      const tenantId = t.membershipId && tenantOf.get(t.membershipId);
      const at = t._max.createdAt;
      if (!tenantId || !at) continue;
      const seen = lastActive.get(tenantId);
      if (!seen || at > seen) lastActive.set(tenantId, at);
    }

    const rows = tenants
      .filter((t) => t.subscription && !isExpired({ status: t.subscription.status, currentPeriodEnd: t.subscription.currentPeriodEnd }, now))
      .map((t) => {
        const sub = t.subscription!;
        const plan = sub.plan;
        const usage = {
          teachers: { used: t._count.teachers, max: plan.maxTeachers },
          students: { used: t._count.students, max: plan.maxStudents },
          storage: {
            used: used.get(t.id) ?? 0,
            max: (poolMb(plan, t._count.memberships) + plan.sharedStorageMb + (extraMb.get(t.id) ?? 0)) * MB,
          },
        };
        const input = {
          createdAt: t.createdAt,
          subscription: { status: sub.status, periodEnd: sub.currentPeriodEnd },
          lastActiveAt: lastActive.get(t.id) ?? null,
          sessions30: recent.get(t.id) ?? 0,
          sessionsPrev30: previous.get(t.id) ?? 0,
          ...usage,
        };
        const mrr = revenueAt(
          [{ at: new Date(0), status: sub.status, periodEnd: sub.currentPeriodEnd, price: Number(plan.priceMonthly ?? 0), currency: plan.currency }],
          now,
        );
        return {
          id: t.id,
          name: t.name,
          slug: t.slug,
          createdAt: t.createdAt,
          plan: { nameAr: plan.nameAr, nameEn: plan.nameEn },
          subscription: { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd },
          mrr,
          lastActiveAt: input.lastActiveAt,
          sessions30: input.sessions30,
          sessionsPrev30: input.sessionsPrev30,
          usage,
          ...assessHealth(input, now),
        };
      });

    const rank = { high: 0, medium: 1 } as const;
    const atRisk = rows
      .filter((r) => r.severity)
      .sort((a, b) => rank[a.severity!] - rank[b.severity!] || (b.mrr?.amount ?? 0) - (a.mrr?.amount ?? 0) || a.name.localeCompare(b.name));
    const top = (r: (typeof rows)[number]) => Math.max(...r.growth.map((g) => g.value ?? 0));
    const growth = rows.filter((r) => r.growth.length).sort((a, b) => top(b) - top(a) || a.name.localeCompare(b.name));

    return { asOf: now, assessed: rows.length, atRisk, growth, thresholds: HEALTH };
  }

  /** Sessions per center that started in [from, to), canceled ones left out. */
  private async sessionsByTenant(from: Date, to: Date) {
    const rows = await this.prisma.session.groupBy({
      by: ['tenantId'],
      where: { startAt: { gte: from, lt: to }, status: { not: 'CANCELED' } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.tenantId, r._count._all]));
  }
}
