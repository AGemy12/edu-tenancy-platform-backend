import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { Prisma, RateKind } from '../generated/prisma/client.js';
import { msg } from '../i18n/i18n.js';
import { BILLABLE_STATUSES, currentRates, effectivePlatformFee, type Rate } from './billing.js';
import { planRateWrite, splitRows, type RateValue } from './prices.js';

type Scope = { kind: RateKind; teacherId: string | null; courseId: string | null; studentId: string | null };

const MAX_AMOUNT = 99_999_999;

/**
 * The center's prices, as the center sees them: a default session price, each course's session
 * price, special prices for students in a course, and each teacher's pay per session. Every write
 * goes through `write`, which keeps the history that billing reads (see prices.ts).
 */
@Injectable()
export class PricesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Admins see every price; a teacher sees their courses' prices and their own pay. */
  async list(user: JwtUser) {
    const tenantId = user.tenantId!;
    const teacherId = user.role === 'TEACHER' ? user.teacherId! : null;
    const name = { user: { select: { fullName: true } } } as const;
    const [tenant, courses, teachers, rows] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { currency: true, chargeAbsent: true, platformFeePercent: true, subscription: { select: { plan: { select: { platformFeePercent: true } } } } },
      }),
      this.prisma.course.findMany({
        where: { tenantId, ...(teacherId ? { teacherId } : {}) },
        select: { id: true, title: true, isActive: true, teacher: { select: { id: true, ...name } }, _count: { select: { enrollments: true } } },
        orderBy: [{ isActive: 'desc' }, { title: 'asc' }],
      }),
      this.prisma.teacher.findMany({ where: { tenantId, ...(teacherId ? { id: teacherId } : {}) }, select: { id: true, ...name }, orderBy: { user: { fullName: 'asc' } } }),
      this.prisma.billingRate.findMany({ where: { tenantId } }),
    ]);

    const current = currentRates(rows.map(toRate), new Date());
    const fees = current.filter((r) => r.kind === 'STUDENT_FEE');
    const courseIds = new Set(courses.map((c) => c.id));
    const special = fees.filter((r) => r.studentId && r.courseId && courseIds.has(r.courseId));
    const students = await this.prisma.student.findMany({
      where: { tenantId, id: { in: special.map((r) => r.studentId!) } },
      select: { id: true, ...name },
    });
    const studentName = new Map(students.map((s) => [s.id, s.user.fullName]));
    const courseTitle = new Map(courses.map((c) => [c.id, c.title]));
    const pay = new Map(current.filter((r) => r.kind === 'TEACHER_PAY').map((r) => [r.teacherId!, { basis: r.basis, amount: r.amount }]));

    const centerPercent = tenant.platformFeePercent === null ? null : Number(tenant.platformFeePercent);
    const packagePercent = tenant.subscription?.plan.platformFeePercent == null ? null : Number(tenant.subscription.plan.platformFeePercent);
    return {
      currency: tenant.currency,
      chargeAbsent: tenant.chargeAbsent,
      // Only the center sees (and pays) the platform's fee.
      ...(user.role === 'TENANT_ADMIN' ? { platformFeePercent: effectivePlatformFee(centerPercent, packagePercent) } : {}),
      defaultPrice: fees.find((r) => !r.courseId && !r.studentId)?.amount ?? null,
      courses: courses.map((c) => ({
        id: c.id,
        title: c.title,
        isActive: c.isActive,
        teacher: { id: c.teacher.id, name: c.teacher.user.fullName },
        students: c._count.enrollments,
        price: fees.find((r) => r.courseId === c.id && !r.studentId)?.amount ?? null,
      })),
      special: special
        .filter((r) => studentName.has(r.studentId!))
        .map((r) => ({
          course: { id: r.courseId!, title: courseTitle.get(r.courseId!)! },
          student: { id: r.studentId!, name: studentName.get(r.studentId!)! },
          price: r.amount,
        }))
        .sort((a, b) => a.course.title.localeCompare(b.course.title) || a.student.name.localeCompare(b.student.name)),
      teachers: teachers.map((t) => ({ id: t.id, name: t.user.fullName, pay: pay.get(t.id) ?? null })),
    };
  }

  /** The current session price of each course in the center. */
  async coursePrices(tenantId: string) {
    const rows = await this.prisma.billingRate.findMany({ where: { tenantId, kind: 'STUDENT_FEE', courseId: { not: null }, studentId: null } });
    return new Map(currentRates(rows.map(toRate), new Date()).map((r) => [r.courseId!, r.amount]));
  }

  /** The current pay of each teacher in the center. */
  async teacherPays(tenantId: string) {
    const rows = await this.prisma.billingRate.findMany({ where: { tenantId, kind: 'TEACHER_PAY' } });
    return new Map(currentRates(rows.map(toRate), new Date()).map((r) => [r.teacherId!, { basis: r.basis, amount: r.amount }]));
  }

  /** The price of a session with no course price (and of sessions with no course at all). */
  setDefaultPrice(tenantId: string, amount: number | null) {
    return this.write(tenantId, { kind: 'STUDENT_FEE', teacherId: null, courseId: null, studentId: null }, price(amount), {}, false);
  }

  async setCoursePrice(tenantId: string, courseId: string, amount: number | null) {
    const course = await this.prisma.course.findFirst({ where: { id: courseId, tenantId }, select: { id: true } });
    if (!course) throw new NotFoundException(msg('courses.notFound'));
    return this.write(tenantId, { kind: 'STUDENT_FEE', teacherId: null, courseId, studentId: null }, price(amount), { courseId }, false);
  }

  /** One student's price in a course (a discount, a sibling…); null returns them to the course's price. */
  async setSpecialPrice(tenantId: string, courseId: string, studentId: string, amount: number | null) {
    const [course, student] = await Promise.all([
      this.prisma.course.findFirst({ where: { id: courseId, tenantId }, select: { id: true } }),
      this.prisma.student.findFirst({ where: { id: studentId, tenantId }, select: { id: true } }),
    ]);
    if (!course) throw new NotFoundException(msg('courses.notFound'));
    if (!student) throw new NotFoundException(msg('students.notFound'));
    return this.write(
      tenantId,
      { kind: 'STUDENT_FEE', teacherId: null, courseId, studentId },
      price(amount),
      { courseId, attendees: { some: { studentId } } },
      true,
    );
  }

  /** What the center pays a teacher per session: a fixed amount, or a % of what its students pay. */
  async setTeacherPay(tenantId: string, teacherId: string, value: RateValue | null) {
    const teacher = await this.prisma.teacher.findFirst({ where: { id: teacherId, tenantId }, select: { id: true } });
    if (!teacher) throw new NotFoundException(msg('teachers.notFound'));
    if (value) {
      assertAmount(value.amount);
      if (value.basis === 'PERCENT' && value.amount > 100) throw new BadRequestException(msg('billing.percentMax'));
    }
    return this.write(tenantId, { kind: 'TEACHER_PAY', teacherId, courseId: null, studentId: null }, value, { teacherId }, false);
  }

  /** Makes `value` the scope's price from now on (see prices.ts for when history is kept). */
  private async write(tenantId: string, scope: Scope, value: RateValue | null, usedBy: Prisma.SessionWhereInput, special: boolean) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.billingRate.findMany({ where: { tenantId, ...scope } });
      const { current, previous, future } = splitRows(
        rows.map((r) => ({ id: r.id, basis: r.basis, amount: Number(r.amount), cleared: r.cleared, effectiveFrom: r.effectiveFrom })),
        now,
      );
      // Prices are no longer scheduled ahead: a change applies now.
      if (future.length) await tx.billingRate.deleteMany({ where: { id: { in: future.map((r) => r.id) } } });
      const used = current
        ? (await tx.session.count({ where: { tenantId, status: { in: BILLABLE_STATUSES }, startAt: { gte: current.effectiveFrom, lte: now }, ...usedBy } })) > 0
        : false;

      const plan = planRateWrite({ current, previous, used, value, now, special });
      const data = value ? { basis: value.basis, amount: value.amount, cleared: false } : { basis: 'PER_SESSION' as const, amount: 0, cleared: true };
      if (plan.op === 'insert') await tx.billingRate.create({ data: { tenantId, ...scope, ...data, effectiveFrom: plan.effectiveFrom } });
      else if (plan.op === 'update') await tx.billingRate.update({ where: { id: plan.id }, data });
      else if (plan.op === 'delete') await tx.billingRate.delete({ where: { id: plan.id } });
    });
  }
}

function assertAmount(amount: number) {
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) throw new BadRequestException(msg('billing.invalidAmount'));
}

/** A student price is always a fixed amount per session. */
function price(amount: number | null): RateValue | null {
  if (amount === null) return null;
  assertAmount(amount);
  return { basis: 'PER_SESSION', amount };
}

export function toRate(r: {
  id: string;
  kind: Rate['kind'];
  basis: Rate['basis'];
  teacherId: string | null;
  courseId: string | null;
  studentId: string | null;
  amount: Prisma.Decimal;
  cleared: boolean;
  effectiveFrom: Date;
}): Rate {
  return {
    id: r.id,
    kind: r.kind,
    basis: r.basis,
    teacherId: r.teacherId,
    courseId: r.courseId,
    studentId: r.studentId,
    amount: Number(r.amount),
    cleared: r.cleared,
    effectiveFrom: r.effectiveFrom,
  };
}
