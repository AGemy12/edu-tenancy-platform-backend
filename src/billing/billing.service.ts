import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { Prisma, RateBasis } from '../generated/prisma/client.js';
import { msg } from '../i18n/i18n.js';
import {
  BILLABLE_STATUSES,
  actualMinutes,
  bookedMinutes,
  chargeCents,
  fromCents,
  isBillable,
  monthKey,
  rateSource,
  rateStatuses,
  resolveRate,
  teacherPayCents,
  type Rate,
  type RateSource,
} from './billing.js';
import type {
  BillingGroup,
  BillingQueryDto,
  BillingSessionsQueryDto,
  BillingSort,
  CreateRateDto,
  RatesQueryDto,
  UpdateRateDto,
} from './dto/billing.dto.js';

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
};

const rateInclude = {
  teacher: { select: { id: true, user: { select: { fullName: true } } } },
  course: { select: { id: true, title: true } },
  student: { select: { id: true, user: { select: { fullName: true } } } },
} as const;

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────── Reports ─────────

  async sessions(user: JwtUser, q: BillingSessionsQueryDto) {
    const { viewer, partial, currency, rows } = await this.compute(user, q);
    sortRows(rows, q.sort ?? 'date_desc');
    const pageSize = q.pageSize ?? DEFAULT_PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = Math.min(q.page ?? 1, pages);
    return {
      currency,
      totals: totals(rows, viewer, partial),
      page,
      pageSize,
      total: rows.length,
      rows: rows.slice((page - 1) * pageSize, page * pageSize).map((r) => serializeRow(r, viewer, partial)),
    };
  }

  async summary(user: JwtUser, q: BillingQueryDto & { groupBy: BillingGroup }) {
    const { viewer, partial, currency, timezone, rows } = await this.compute(user, q);
    const groups = new Map<string, { key: string; label: string | null; sessions: number; minutes: number; fees: number; pay: number }>();
    const add = (key: string, label: string | null, minutes: number, fees: number, pay: number) => {
      const g = groups.get(key) ?? { key, label, sessions: 0, minutes: 0, fees: 0, pay: 0 };
      g.sessions += 1;
      g.minutes += minutes;
      g.fees += fees;
      g.pay += pay;
      groups.set(key, g);
    };
    for (const r of rows) {
      if (q.groupBy === 'student') {
        for (const l of r.lines) add(l.studentId, l.name, l.minutes, l.feeCents, 0);
        continue;
      }
      const [key, label] =
        q.groupBy === 'teacher'
          ? [r.teacher.id, r.teacher.name]
          : q.groupBy === 'course'
            ? [r.course?.id ?? 'none', r.course?.title ?? null]
            : [monthKey(r.startAt, timezone), null];
      add(key, label, r.minutes, r.feesCents, r.pay?.cents ?? 0);
    }

    const showPay = viewer !== 'student' && q.groupBy !== 'student';
    const showNet = showPay && viewer === 'admin' && !partial;
    const list = [...groups.values()].sort((a, b) =>
      q.groupBy === 'month' ? b.key.localeCompare(a.key) : b.fees - a.fees || (a.label ?? '').localeCompare(b.label ?? ''),
    );
    return {
      currency,
      groupBy: q.groupBy,
      totals: totals(rows, viewer, partial),
      groups: list.map((g) => ({
        key: g.key,
        label: g.label,
        sessions: g.sessions,
        minutes: g.minutes,
        fees: fromCents(g.fees),
        ...(showPay ? { teacherPay: fromCents(g.pay) } : {}),
        ...(showNet ? { net: fromCents(g.fees - g.pay) } : {}),
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

  // ───────── Rate card ─────────

  async listRates(user: JwtUser, q: RatesQueryDto) {
    const tenantId = user.tenantId!;
    const rows = await this.prisma.billingRate.findMany({
      where: { tenantId, kind: q.kind, teacherId: user.role === 'TEACHER' ? user.teacherId! : q.teacherId },
      include: rateInclude,
      orderBy: [{ teacher: { user: { fullName: 'asc' } } }, { kind: 'asc' }, { effectiveFrom: 'desc' }],
    });
    const statuses = rateStatuses(rows.map(toRate), new Date());
    return rows.map((r) => ({ ...serializeRate(r), state: statuses.get(r.id) }));
  }

  async createRate(user: JwtUser, dto: CreateRateDto) {
    const tenantId = user.tenantId!;
    const basis = dto.basis ?? 'PER_HOUR';
    assertRateShape(dto.kind, basis, dto.amount, dto.studentId);

    const teacher = await this.prisma.teacher.findFirst({ where: { id: dto.teacherId, tenantId }, select: { id: true } });
    if (!teacher) throw new NotFoundException(msg('teachers.notFound'));
    if (dto.courseId) {
      const course = await this.prisma.course.findFirst({ where: { id: dto.courseId, tenantId, teacherId: dto.teacherId } });
      if (!course) throw new NotFoundException(msg('sessions.courseNotFound'));
    }
    if (dto.studentId) {
      const student = await this.prisma.student.findFirst({ where: { id: dto.studentId, tenantId }, select: { id: true } });
      if (!student) throw new NotFoundException(msg('students.notFound'));
    }

    const scope = { tenantId, kind: dto.kind, teacherId: dto.teacherId, courseId: dto.courseId ?? null, studentId: dto.studentId ?? null };
    const effectiveFrom = new Date(dto.effectiveFrom);
    await this.assertNoTwin(scope, effectiveFrom);
    const row = await this.prisma.billingRate.create({
      data: { ...scope, basis, amount: dto.amount, effectiveFrom, note: dto.note },
      include: rateInclude,
    });
    return serializeRate(row);
  }

  async updateRate(user: JwtUser, id: string, dto: UpdateRateDto) {
    const rate = await this.getRate(user, id);
    const basis = dto.basis ?? rate.basis;
    assertRateShape(rate.kind, basis, dto.amount ?? Number(rate.amount), rate.studentId);
    const effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : undefined;
    if (effectiveFrom && effectiveFrom.getTime() !== rate.effectiveFrom.getTime()) {
      const { tenantId, kind, teacherId, courseId, studentId } = rate;
      await this.assertNoTwin({ tenantId, kind, teacherId, courseId, studentId }, effectiveFrom, id);
    }
    const row = await this.prisma.billingRate.update({
      where: { id },
      data: { basis, amount: dto.amount, effectiveFrom, note: dto.note },
      include: rateInclude,
    });
    return serializeRate(row);
  }

  async removeRate(user: JwtUser, id: string) {
    await this.getRate(user, id);
    await this.prisma.billingRate.delete({ where: { id } });
  }

  // ───────── helpers ─────────

  /** Every session the viewer may see that matches the filters, priced. */
  private async compute(user: JwtUser, q: BillingQueryDto) {
    const tenantId = user.tenantId!;
    const viewer: Viewer = user.role === 'STUDENT' ? 'student' : user.role === 'TEACHER' ? 'teacher' : 'admin';
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (!(to.getTime() > from.getTime())) throw new BadRequestException(msg('billing.invalidRange'));
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      throw new BadRequestException(msg('billing.rangeTooLong', { days: MAX_RANGE_DAYS }));
    }

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

    const [tenant, sessions] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { currency: true, timezone: true } }),
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
            select: { studentId: true, attended: true, joinedAt: true, student: { select: { user: { select: { fullName: true } } } } },
            orderBy: { student: { user: { fullName: 'asc' } } },
          },
        },
      }),
    ]);

    const teacherIds = [...new Set(sessions.map((s) => s.teacherId))];
    const rates = teacherIds.length
      ? (await this.prisma.billingRate.findMany({ where: { tenantId, teacherId: { in: teacherIds } } })).map(toRate)
      : [];

    const rows: Row[] = [];
    for (const s of sessions) {
      const billable = isBillable(s.status);
      const minutes = billable ? bookedMinutes(s) : 0;
      const all: Line[] = s.attendees.map((a) => {
        const rate = billable
          ? resolveRate(rates, { kind: 'STUDENT_FEE', teacherId: s.teacherId, courseId: s.courseId, studentId: a.studentId, at: s.startAt })
          : null;
        return {
          studentId: a.studentId,
          name: a.student.user.fullName,
          attended: a.attended,
          joinedAt: a.joinedAt,
          minutes,
          rate: rate?.amount ?? null,
          rateSource: rate ? rateSource(rate) : null,
          feeCents: rate ? chargeCents(rate.amount, minutes) : 0,
        };
      });
      const sessionFeesCents = sum(all.map((l) => l.feeCents));
      const payRate =
        billable && viewer !== 'student'
          ? resolveRate(rates, { kind: 'TEACHER_PAY', teacherId: s.teacherId, courseId: s.courseId, at: s.startAt })
          : null;

      let lines = studentId ? all.filter((l) => l.studentId === studentId) : all;
      if (q.attendance) {
        lines = lines.filter((l) => l.attended === (q.attendance === 'attended'));
        if (lines.length === 0) continue;
      }
      if (q.missingRate && !(billable && lines.some((l) => l.rate === null))) continue;

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
        sessionFeesCents,
        pay: payRate
          ? {
              cents: teacherPayCents(payRate, minutes, sessionFeesCents),
              basis: payRate.basis,
              rate: payRate.amount,
              source: rateSource(payRate),
            }
          : null,
      });
    }

    return {
      viewer,
      // Some students' lines are hidden, so the center's net for these sessions can't be shown.
      partial: Boolean(studentId || q.attendance),
      currency: tenant?.currency ?? 'EGP',
      timezone: tenant?.timezone ?? 'UTC',
      rows,
    };
  }

  private async getRate(user: JwtUser, id: string) {
    const rate = await this.prisma.billingRate.findFirst({ where: { id, tenantId: user.tenantId! } });
    if (!rate) throw new NotFoundException(msg('billing.rateNotFound'));
    return rate;
  }

  /** Two prices for the same people starting the same moment would make the report ambiguous. */
  private async assertNoTwin(scope: Prisma.BillingRateWhereInput, effectiveFrom: Date, exceptId?: string) {
    const twin = await this.prisma.billingRate.findFirst({
      where: { ...scope, effectiveFrom, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (twin) throw new ConflictException(msg('billing.rateExists'));
  }
}

function assertRateShape(kind: string, basis: RateBasis, amount: number, studentId: string | null | undefined) {
  if (kind === 'TEACHER_PAY' && studentId) throw new BadRequestException(msg('billing.teacherPayNoStudent'));
  if (basis === 'PERCENT' && kind !== 'TEACHER_PAY') throw new BadRequestException(msg('billing.percentOnlyTeacherPay'));
  if (basis === 'PERCENT' && amount > 100) throw new BadRequestException(msg('billing.percentMax'));
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function toRate(r: {
  id: string;
  kind: Rate['kind'];
  basis: RateBasis;
  teacherId: string;
  courseId: string | null;
  studentId: string | null;
  amount: Prisma.Decimal;
  effectiveFrom: Date;
}): Rate {
  return { ...r, amount: Number(r.amount) };
}

function serializeRate<
  T extends {
    amount: Prisma.Decimal;
    courseId: string | null;
    studentId: string | null;
    teacher: { id: string; user: { fullName: string } };
    course: { id: string; title: string } | null;
    student: { id: string; user: { fullName: string } } | null;
  },
>(r: T) {
  const { teacher, course, student, ...rest } = r;
  return {
    ...rest,
    amount: Number(r.amount),
    source: rateSource(r),
    teacher: { id: teacher.id, name: teacher.user.fullName },
    course,
    student: student ? { id: student.id, name: student.user.fullName } : null,
  };
}

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
  return {
    sessions: rows.length,
    chargedSessions: rows.filter((r) => r.billable).length,
    /** Teaching time: each session once. */
    minutes: sum(rows.map((r) => r.minutes)),
    /** Charged student time: each student on each session. */
    studentMinutes: sum(lines.map((l) => l.minutes)),
    fees: fromCents(fees),
    ...(viewer !== 'student' ? { teacherPay: fromCents(pay) } : {}),
    ...(viewer === 'admin' && !partial ? { net: fromCents(fees - pay) } : {}),
    missingRates: rows.filter((r) => r.billable).flatMap((r) => r.lines).filter((l) => l.rate === null).length,
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
      minutes: l.minutes,
      rate: l.rate,
      rateSource: l.rateSource,
      fee: fromCents(l.feeCents),
    })),
    fees: fromCents(r.feesCents),
    ...(viewer !== 'student'
      ? { teacherPay: r.pay ? { amount: fromCents(r.pay.cents), basis: r.pay.basis, rate: r.pay.rate, source: r.pay.source } : null }
      : {}),
    ...(viewer === 'admin' && !partial ? { net: fromCents(r.sessionFeesCents - (r.pay?.cents ?? 0)) } : {}),
  };
}
