import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Plan } from '../generated/prisma/client.js';
import type { Locale } from '../i18n/locale.js';
import { msg } from '../i18n/i18n.js';
import type { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto.js';

/** Package new centers start their trial on. */
export const TRIAL_PLAN_CODE = process.env.TRIAL_PLAN_CODE ?? 'BASIC';

@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  /** The tenant's current package; limits are always read from here. */
  async forTenant(tenantId: string): Promise<Plan> {
    const sub = await this.prisma.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
    if (!sub) throw new NotFoundException(msg('plans.notConfigured'));
    return sub.plan;
  }

  /** Public catalog for the upgrade screen, with the tenant's package marked. */
  async list(tenantId: string, locale: Locale) {
    const [plans, current] = await Promise.all([
      this.prisma.plan.findMany({ where: { isActive: true, isPublic: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.subscription.findUnique({ where: { tenantId }, select: { planId: true } }),
    ]);
    return plans.map((p) => ({
      id: p.id,
      ...this.summary(p, locale),
      description: (locale === 'en' ? p.descriptionEn : p.descriptionAr) ?? null,
      priceMonthly: p.priceMonthly?.toString() ?? null,
      currency: p.currency,
      maxTeachers: p.maxTeachers,
      maxStudents: p.maxStudents,
      isCurrent: p.id === current?.planId,
    }));
  }

  /** Super admin: the whole catalog, hidden and retired packages included, with how many centers are on each. */
  async all() {
    const rows = await this.prisma.plan.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], include: { _count: { select: { subscriptions: true } } } });
    return rows.map((p) => this.adminRow(p));
  }

  async create(dto: CreatePlanDto) {
    const taken = await this.prisma.plan.findUnique({ where: { code: dto.code } });
    if (taken) throw new ConflictException(msg('plans.codeTaken'));
    const plan = await this.prisma.plan.create({ data: { ...dto, currency: dto.currency?.toUpperCase() }, include: { _count: { select: { subscriptions: true } } } });
    return this.adminRow(plan);
  }

  async update(id: string, dto: UpdatePlanDto) {
    await this.get(id);
    const plan = await this.prisma.plan.update({
      where: { id },
      data: { ...dto, currency: dto.currency?.toUpperCase() },
      include: { _count: { select: { subscriptions: true } } },
    });
    return this.adminRow(plan);
  }

  /** A package some center is on can only be retired (`isActive: false`), never deleted. */
  async remove(id: string) {
    const plan = await this.get(id);
    if (plan._count.subscriptions > 0) throw new ConflictException(msg('plans.inUse', { count: plan._count.subscriptions }));
    await this.prisma.plan.delete({ where: { id } });
  }

  private async get(id: string) {
    const plan = await this.prisma.plan.findUnique({ where: { id }, include: { _count: { select: { subscriptions: true } } } });
    if (!plan) throw new NotFoundException(msg('plans.notFound'));
    return plan;
  }

  private adminRow({ _count, priceMonthly, ...p }: Plan & { _count: { subscriptions: number } }) {
    return { ...p, priceMonthly: priceMonthly?.toString() ?? null, tenants: _count.subscriptions };
  }

  summary(plan: Plan, locale: Locale) {
    return {
      code: plan.code,
      name: locale === 'en' ? plan.nameEn : plan.nameAr,
      storagePerTeacherMb: plan.storagePerTeacherMb,
      sharedStorageMb: plan.sharedStorageMb,
      maxFileMb: plan.maxFileMb,
    };
  }
}
