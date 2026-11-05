import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { AttendanceStatus, Prisma, RateBasis } from '../generated/prisma/client.js';
import { msg } from '../i18n/i18n.js';
import { isExpired } from '../tenants/subscription.js';
import {
  BILLABLE_STATUSES,
  actualMinutes,
  bookedMinutes,
  chargeOf,
  effectivePlatformFee,
  fromCents,
  isBillable,
  monthKey,
  platformFeeCents,
  rateSource,
  resolveRate,
  sessionFeesCents,
  studentFeeCents,
  teacherIsPaid,
  teacherPayCents,
  type FreeReason,
  type RateSource,
} from './billing.js';
import { toRate } from './prices.service.js';
import type { BillingGroup, BillingQueryDto, BillingSessionsQueryDto, BillingSort, PlatformBillingQueryDto } from './dto/billing.dto.js';

/** One report covers at most a year, so it can be computed in memory. */
export const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 25;

/** What a viewer may see: admins everything, teachers their sessions and pay, students their own charges. */
type Viewer = 'admin' | 'teacher' | 'student';

type Line = {
  studentId: string;
  name: string;
  attended: boolean;
  joinedAt: Date | null;
  /** The teacher's evaluation; null until the session is evaluated. */
  status: AttendanceStatus | null;
  /** Whether this student pays for the session; `free` says why not. */
  charged: boolean;
  free: FreeReason | null;
  minutes: number;
  rate: number | null;
  rateSource: RateSource | null;
  feeCents: number;
};

type Pay = { cents: number; basis: RateBasis; rate: number; source: RateSource } | null;

type Row = {
  id: string;
  title: string;
  status: string;
  provider: string;
  startAt: Date;
  endAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  billable: boolean;
  /** The teacher's entry was recorded (start time); otherwise the session was only assumed held. */
  confirmed: boolean;
  minutes: number;
  actualMinutes: number | null;
  teacher: { id: string; name: string };
  course: { id: string; title: string } | null;
  lines: Line[];
  feesCents: number;
  /** Fees of every student on the session, even when only some lines are shown. */
  sessionFeesCents: number;
  pay: Pay;
  /** The platform's commission on the whole session's fees. */
  platformFeeCents: number;
};

/** Sessions with what's needed to price them, no names. */
const pricingSelect = {
  status: true,
  startAt: true,
  teacherId: true,
  courseId: true,
  attendees: { select: { studentId: true, status: true } },
} as const;

const percentOf = (d: Prisma.Decimal | null | undefined) => (d == null ? null : Number(d));

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────── Reports ─────────

  async sessions(user: JwtUser, q: BillingSessionsQueryDto) {
    const { viewer, partial, currency, platformFeePercent, rows } = await this.compute(user, q);
    sortRows(rows, q.sort ?? 'date_desc');
    const pageSize = q.pageSize ?? DEFAULT_PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = Math.min(q.page ?? 1, pages);
    return {
      currency,
      ...(viewer === 'admin' ? { platformFeePercent } : {}),
      totals: totals(rows, viewer, partial),
      page,
      pageSize,
      total: rows.length,
      rows: rows.slice((page - 1) * pageSize, page * pageSize).map((r) => serializeRow(r, viewer, partial)),
    };
  }

  async summary(user: JwtUser, q: BillingQueryDto & { groupBy: BillingGroup }) {
    const { viewer, partial, currency, timezone, platformFeePercent, rows } = await this.compute(user, q);
    type Group = { key: string; label: string | null; sessions: number; minutes: number; fees: number; pay: number; platformFee: number };
    const groups = new Map<string, Group>();
    const add = (key: string, label: string | null, minutes: number, fees: number, pay: number, platformFee: number) => {
      const g = groups.get(key) ?? { key, label, sessions: 0, minutes: 0, fees: 0, pay: 0, platformFee: 0 };
      g.sessions += 1;
      g.minutes += minutes;
      g.fees += fees;
      g.pay += pay;
      g.platformFee += platformFee;
      groups.set(key, g);
    };
    for (const r of rows) {
      if (q.groupBy === 'student') {
        for (const l of r.lines) add(l.studentId, l.name, l.minutes, l.feeCents, 0, 0);
        continue;
      }
      const [key, label] =
        q.groupBy === 'teacher'
          ? [r.teacher.id, r.teacher.name]
          : q.groupBy === 'course'
            ? [r.course?.id ?? 'none', r.course?.title ?? null]
            : [monthKey(r.startAt, timezone), null];
      add(key, label, r.minutes, r.feesCents, r.pay?.cents ?? 0, r.platformFeeCents);
    }

    const showPay = viewer !== 'student' && q.groupBy !== 'student';
    const showNet = showPay && viewer === 'admin' && !partial;
    const list = [...groups.values()].sort((a, b) =>
      q.groupBy === 'month' ? b.key.localeCompare(a.key) : b.fees - a.fees || (a.label ?? '').localeCompare(b.label ?? ''),
    );
    return {
      currency,
      ...(viewer === 'admin' ? { platformFeePercent } : {}),
      groupBy: q.groupBy,
      totals: totals(rows, viewer, partial),
      groups: list.map((g) => ({
        key: g.key,
        label: g.label,
        sessions: g.sessions,
        minutes: g.minutes,
        fees: fromCents(g.fees),
        ...(showPay ? { teacherPay: fromCents(g.pay) } : {}),
        ...(showNet ? { platformFee: fromCents(g.platformFee), net: fromCents(g.fees - g.pay - g.platformFee) } : {}),
      })),
    };
  }

  /** The teachers, students and courses a viewer can filter by. */
  async options(user: JwtUser) {
    const tenantId = user.tenantId!;
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { currency: true } });
    const name = { user: { select: { fullName: true } } } as const;
    const byName = { user: { fullName: 'asc' } } as const;

    let teacherWhere: Prisma.TeacherWhereInput = { tenantId };
    let studentWhere: Prisma.StudentWhereInput | null = { tenantId };
    let courseWhere: Prisma.CourseWhereInput = { tenantId };
    if (user.role === 'TEACHER') {
      const teacherId = user.teacherId!;
      teacherWhere = { tenantId, id: teacherId };
      studentWhere = {
        tenantId,
        OR: [
          { teachers: { some: { teacherId } } },
          { enrollments: { some: { course: { teacherId } } } },
          { attendances: { some: { session: { teacherId } } } },
        ],
      };
      courseWhere = { tenantId, teacherId };
    } else if (user.role === 'STUDENT') {
      const studentId = user.studentId!;
      teacherWhere = {
        tenantId,
        OR: [
          { students: { some: { studentId } } },
          { courses: { some: { enrollments: { some: { studentId } } } } },
          { sessions: { some: { attendees: { some: { studentId } } } } },
        ],
      };
      studentWhere = null;
      courseWhere = {
        tenantId,
        OR: [{ enrollments: { some: { studentId } } }, { sessions: { some: { attendees: { some: { studentId } } } } }],
      };
    }

    const [teachers, students, courses] = await Promise.all([
      this.prisma.teacher.findMany({ where: teacherWhere, select: { id: true, ...name }, orderBy: byName }),
      studentWhere ? this.prisma.student.findMany({ where: studentWhere, select: { id: true, ...name }, orderBy: byName }) : [],
      this.prisma.course.findMany({ where: courseWhere, select: { id: true, title: true, teacherId: true }, orderBy: { title: 'asc' } }),
    ]);
    return {
      currency: tenant?.currency ?? 'EGP',
      teachers: teachers.map((t) => ({ id: t.id, name: t.user.fullName })),
      students: students.map((s) => ({ id: s.id, name: s.user.fullName })),
      courses: courses.map((c) => ({ id: c.id, title: c.title, teacherId: c.teacherId })),
    };
  }

  /**
   * Super admin: what the platform earns from every center over a period — the subscription
   * price and the commission on session fees (computed with each center's own percentage).
   */
  async platform(q: PlatformBillingQueryDto) {
    const { from, to } = parseRange(q);
    const tenants = await this.prisma.tenant.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        currency: true,
        chargeAbsent: true,
        platformFeePercent: true,
        subscription: {
          select: {
            status: true,
            currentPeriodEnd: true,
            plan: { select: { nameAr: true, nameEn: true, priceMonthly: true, currency: true, platformFeePercent: true } },
          },
        },
        billingRates: { where: { kind: 'STUDENT_FEE' } },
        sessions: { where: { startAt: { gte: from, lt: to }, status: { in: BILLABLE_STATUSES } }, select: pricingSelect },
      },
      orderBy: { name: 'asc' },
    });

    const rows = tenants.map((t) => {
      const rates = t.billingRates.map(toRate);
      const own = percentOf(t.platformFeePercent);
      const percent = effectivePlatformFee(own, percentOf(t.subscription?.plan.platformFeePercent));
      const fees = t.sessions.reduce((sum, s) => sum + sessionFeesCents(s, rates, t.chargeAbsent), 0);
      return {
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        currency: t.currency,
        platformFeePercent: percent,
        /** The fee comes from the package (the center has no percentage of its own). */
        platformFeeFromPlan: own === null,
        sessions: t.sessions.length,
        fees: fromCents(fees),
        platformFee: fromCents(platformFeeCents(fees, percent)),
        subscription: t.subscription
          ? {
              status: t.subscription.status,
              expired: isExpired(t.subscription),
              plan: {
                nameAr: t.subscription.plan.nameAr,
                nameEn: t.subscription.plan.nameEn,
                priceMonthly: t.subscription.plan.priceMonthly === null ? null : Number(t.subscription.plan.priceMonthly),
                currency: t.subscription.plan.currency,
              },
            }
          : null,
      };
    });

    // Centers bill in their own currencies, so platform totals are per currency.
    const byCurrency = new Map<string, { currency: string; centers: number; withFee: number; sessions: number; fees: number; platformFee: number }>();
    for (const r of rows) {
      const g = byCurrency.get(r.currency) ?? { currency: r.currency, centers: 0, withFee: 0, sessions: 0, fees: 0, platformFee: 0 };
      g.centers += 1;
      if (r.platformFeePercent !== null) g.withFee += 1;
      g.sessions += r.sessions;
      g.fees += r.fees;
      g.platformFee += r.platformFee;
      byCurrency.set(r.currency, g);
    }
    return {
      from,
      to,
      totals: [...byCurrency.values()].map((g) => ({ ...g, fees: round2(g.fees), platformFee: round2(g.platformFee) })),
      tenants: rows.sort((a, b) => b.platformFee - a.platformFee || b.fees - a.fees || a.name.localeCompare(b.name)),
    };
  }

  // ───────── helpers ─────────

  /** Every session the viewer may see that matches the filters, priced. */
  private async compute(user: JwtUser, q: BillingQueryDto) {
    const tenantId = user.tenantId!;
    const viewer: Viewer = user.role === 'STUDENT' ? 'student' : user.role === 'TEACHER' ? 'teacher' : 'admin';
    const { from, to } = parseRange(q);

    const teacherId = viewer === 'teacher' ? user.teacherId! : q.teacherId;
    const studentId = viewer === 'student' ? user.studentId! : q.studentId;
    const search = q.q ? { contains: q.q, mode: 'insensitive' as const } : undefined;
    const where: Prisma.SessionWhereInput = {
      tenantId,
      startAt: { gte: from, lt: to },
      status: { in: q.status?.length ? q.status : BILLABLE_STATUSES },
      teacherId,
      courseId: q.courseId,
      provider: q.provider,
      ...(studentId ? { attendees: { some: { studentId } } } : {}),
      ...(q.entry === 'confirmed' ? { startedAt: { not: null } } : q.entry === 'unconfirmed' ? { startedAt: null } : {}),
      ...(search
        ? {
            OR: [
              { title: search },
              { course: { title: search } },
              { teacher: { user: { fullName: search } } },
              // Students search their own sessions only, so other students' names aren't matched.
              ...(viewer === 'student' ? [] : [{ attendees: { some: { student: { user: { fullName: search } } } } }]),
            ],
          }
        : {}),
    };

    const [tenant, sessions, rateRows] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          currency: true,
          timezone: true,
          chargeAbsent: true,
          platformFeePercent: true,
          subscription: { select: { plan: { select: { platformFeePercent: true } } } },
        },
      }),
      this.prisma.session.findMany({
        where,
        orderBy: { startAt: 'desc' },
        select: {
          id: true,
          title: true,
          status: true,
          provider: true,
          startAt: true,
          endAt: true,
          startedAt: true,
          endedAt: true,
          teacherId: true,
          courseId: true,
          teacher: { select: { user: { select: { fullName: true } } } },
          course: { select: { id: true, title: true } },
          // All of them, even when one student is filtered: the teacher's share depends on the whole session.
          attendees: {
            select: { studentId: true, attended: true, joinedAt: true, status: true, student: { select: { user: { select: { fullName: true } } } } },
            orderBy: { student: { user: { fullName: 'asc' } } },
          },
        },
      }),
      // The whole rate card: the center's default price has no course, so it can't be narrowed by one.
      this.prisma.billingRate.findMany({ where: { tenantId } }),
    ]);
    const rates = rateRows.map(toRate);
    const chargeAbsent = tenant?.chargeAbsent ?? true;
    // Only the center sees (and pays) the platform's fee.
    const platformFeePercent =
      viewer === 'admin' ? effectivePlatformFee(percentOf(tenant?.platformFeePercent), percentOf(tenant?.subscription?.plan.platformFeePercent)) : null;

    const rows: Row[] = [];
    for (const s of sessions) {
      const billable = isBillable(s.status);
      const minutes = billable ? bookedMinutes(s) : 0;
      const all: Line[] = s.attendees.map((a) => {
        const charge = billable ? chargeOf(a.status, chargeAbsent) : null;
        const rate = billable
          ? resolveRate(rates, { kind: 'STUDENT_FEE', teacherId: s.teacherId, courseId: s.courseId, studentId: a.studentId, at: s.startAt })
          : null;
        const charged = Boolean(charge?.charged);
        return {
          studentId: a.studentId,
          name: a.student.user.fullName,
          attended: a.attended,
          joinedAt: a.joinedAt,
          status: a.status,
          charged,
          free: charge && !charge.charged ? charge.reason : null,
          minutes: charged ? minutes : 0,
          rate: rate?.amount ?? null,
          rateSource: rate ? rateSource(rate) : null,
          feeCents: rate && charged ? studentFeeCents(rate) : 0,
        };
      });
      const sessionFees = sum(all.map((l) => l.feeCents));
      const payRate =
        billable && viewer !== 'student'
          ? resolveRate(rates, { kind: 'TEACHER_PAY', teacherId: s.teacherId, courseId: s.courseId, at: s.startAt })
          : null;
      const paid = teacherIsPaid(s.attendees.map((a) => a.status));

      let lines = studentId ? all.filter((l) => l.studentId === studentId) : all;
      if (q.attendance) {
        lines = lines.filter((l) => l.attended === (q.attendance === 'attended'));
        if (lines.length === 0) continue;
      }
      if (q.missingRate && !(billable && lines.some((l) => l.charged && l.rate === null))) continue;

      rows.push({
        id: s.id,
        title: s.title,
        status: s.status,
        provider: s.provider,
        startAt: s.startAt,
        endAt: s.endAt,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        billable,
        confirmed: s.startedAt !== null,
        minutes,
        actualMinutes: actualMinutes(s),
        teacher: { id: s.teacherId, name: s.teacher.user.fullName },
        course: s.course,
        lines,
        feesCents: sum(lines.map((l) => l.feeCents)),
        sessionFeesCents: sessionFees,
        pay: payRate
          ? {
              cents: paid ? teacherPayCents(payRate, sessionFees) : 0,
              basis: payRate.basis,
              rate: payRate.amount,
              source: rateSource(payRate),
            }
          : null,
        platformFeeCents: platformFeeCents(sessionFees, platformFeePercent),
      });
    }

    return {
      viewer,
      // Some students' lines are hidden, so the center's net for these sessions can't be shown.
      partial: Boolean(studentId || q.attendance),
      currency: tenant?.currency ?? 'EGP',
      timezone: tenant?.timezone ?? 'UTC',
      platformFeePercent,
      rows,
    };
  }
}

function parseRange(q: { from: string; to: string }) {
  const from = new Date(q.from);
  const to = new Date(q.to);
  if (!(to.getTime() > from.getTime())) throw new BadRequestException(msg('billing.invalidRange'));
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new BadRequestException(msg('billing.rangeTooLong', { days: MAX_RANGE_DAYS }));
  }
  return { from, to };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

function sortRows(rows: Row[], sort: BillingSort) {
  const byDate = (a: Row, b: Row) => b.startAt.getTime() - a.startAt.getTime();
  const compare: Record<BillingSort, (a: Row, b: Row) => number> = {
    date_desc: byDate,
    date_asc: (a, b) => -byDate(a, b),
    amount_desc: (a, b) => b.feesCents - a.feesCents || byDate(a, b),
    amount_asc: (a, b) => a.feesCents - b.feesCents || byDate(a, b),
    duration_desc: (a, b) => b.minutes - a.minutes || byDate(a, b),
  };
  rows.sort(compare[sort]);
}

function totals(rows: Row[], viewer: Viewer, partial: boolean) {
  const lines = rows.flatMap((r) => r.lines);
  const fees = sum(lines.map((l) => l.feeCents));
  const pay = sum(rows.map((r) => r.pay?.cents ?? 0));
  const platformFee = sum(rows.map((r) => r.platformFeeCents));
  return {
    sessions: rows.length,
    chargedSessions: rows.filter((r) => r.billable).length,
    /** Teaching time: each session once. */
    minutes: sum(rows.map((r) => r.minutes)),
    /** Charged student time: each student on each session. */
    studentMinutes: sum(lines.map((l) => l.minutes)),
    fees: fromCents(fees),
    ...(viewer !== 'student' ? { teacherPay: fromCents(pay) } : {}),
    ...(viewer === 'admin' && !partial ? { platformFee: fromCents(platformFee), net: fromCents(fees - pay - platformFee) } : {}),
    missingRates: rows.filter((r) => r.billable).flatMap((r) => r.lines).filter((l) => l.charged && l.rate === null).length,
    /** Students on charged sessions who paid nothing (excused, or absent when absences are free). */
    freeSeats: lines.filter((l) => l.free !== null).length,
    unconfirmed: rows.filter((r) => r.billable && !r.confirmed).length,
  };
}

function serializeRow(r: Row, viewer: Viewer, partial: boolean) {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    provider: r.provider,
    startAt: r.startAt,
    endAt: r.endAt,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    billable: r.billable,
    confirmed: r.confirmed,
    minutes: r.minutes,
    actualMinutes: r.actualMinutes,
    teacher: r.teacher,
    course: r.course,
    students: r.lines.map((l) => ({
      id: l.studentId,
      name: l.name,
      attended: l.attended,
      joinedAt: l.joinedAt,
      status: l.status,
      charged: l.charged,
      free: l.free,
      minutes: l.minutes,
      rate: l.rate,
      rateSource: l.rateSource,
      fee: fromCents(l.feeCents),
    })),
    fees: fromCents(r.feesCents),
    ...(viewer !== 'student'
      ? { teacherPay: r.pay ? { amount: fromCents(r.pay.cents), basis: r.pay.basis, rate: r.pay.rate, source: r.pay.source } : null }
      : {}),
    ...(viewer === 'admin' && !partial
      ? { platformFee: fromCents(r.platformFeeCents), net: fromCents(r.sessionFeesCents - (r.pay?.cents ?? 0) - r.platformFeeCents) }
      : {}),
  };
}
