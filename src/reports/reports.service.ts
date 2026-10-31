import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { AccountStatus, AttendanceStatus, EnrollmentStatus, SessionStatus } from '../generated/prisma/enums.js';
import { msg } from '../i18n/i18n.js';
import { BillingService } from '../billing/billing.service.js';
import type { BillingSummaryQueryDto } from '../billing/dto/billing.dto.js';
import { actualMinutes, bookedMinutes } from '../billing/billing.js';
import {
  HELD,
  MAX_DAYS,
  ON_TIME_GRACE_MIN,
  average,
  buckets,
  dayCount,
  dayKey,
  distribution,
  isEvaluated,
  monthStarts,
  outcomeOf,
  percentOf,
  periodBounds,
  previousPeriod,
  riskFlags,
  round1,
  startDelay,
  summarizeSeats,
  type Outcome,
  type RiskFlag,
  type Seat,
  type SeatSummary,
} from './report-rules.js';
import type { ReportQueryDto, StudentReportQueryDto } from './dto/report.dto.js';

/** An attendance register lists one column per session, so it stays printable. */
export const MAX_REGISTER_SESSIONS = 160;

type Viewer = 'admin' | 'teacher' | 'student';

export type Period = { from: string; to: string; days: number; timezone: string };
export type CenterInfo = { name: string; currency: string };
type Ctx = Period & { tenantId: string; viewer: Viewer; start: Date; end: Date; center: CenterInfo; logoKey: string | null };
type Named = { id: string; name: string };
type Filters = { teacher: Named | null; course: { id: string; title: string } | null };

/** What every report starts with: when it was made, the period, the center and the narrowing. */
export type ReportHead = { generatedAt: string; period: Period; center: CenterInfo; filters: Filters };

const nameSelect = { user: { select: { fullName: true } } } as const;

const sessionSelect = {
  id: true,
  title: true,
  status: true,
  startAt: true,
  endAt: true,
  startedAt: true,
  endedAt: true,
  teacherId: true,
  courseId: true,
  teacher: { select: nameSelect },
  course: { select: { id: true, title: true } },
} as const;

const seatSelect = { studentId: true, attended: true, status: true, rating: true } as const;

/** A session with every seat on it, for the reports that look at whole sessions. */
type SessionWithSeats = {
  id: string;
  title: string;
  status: SessionStatus;
  startAt: Date;
  endAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  teacherId: string;
  courseId: string | null;
  teacher: { user: { fullName: string } };
  course: { id: string; title: string } | null;
  attendees: { studentId: string; attended: boolean; status: AttendanceStatus | null; rating: number | null; student: { user: { fullName: string } } }[];
};

const seatOf = (
  s: { status: SessionStatus; startAt: Date; endAt: Date },
  a: { attended: boolean; status: AttendanceStatus | null; rating: number | null },
): Seat => ({ outcome: outcomeOf(s, a), minutes: bookedMinutes(s), rating: a.rating, at: s.startAt });

const isHeld = (status: SessionStatus) => status === 'COMPLETED' || status === 'LIVE';

const groupBy = <T, K>(xs: T[], key: (x: T) => K) => {
  const m = new Map<K, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

const isRealDay = (d: string) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  /** The teachers, students and courses the viewer can narrow reports by. */
  options(user: JwtUser) {
    return this.billing.options(user);
  }

  // ───────── One student ─────────

  async student(user: JwtUser, studentId: string, q: StudentReportQueryDto) {
    const ctx = await this.context(user, q);
    const student = await this.prisma.student.findFirst({
      // AND, not a spread: the viewer's scope may itself pin `id` (a student sees only themselves).
      where: { AND: [{ id: studentId }, this.studentWhere(user)] },
      select: {
        id: true,
        grade: true,
        parentPhone: true,
        createdAt: true,
        user: { select: { fullName: true, email: true, phone: true } },
        membership: { select: { status: true } },
        teachers: { select: { teacher: { select: nameSelect } } },
        enrollments: {
          select: { status: true, enrolledAt: true, course: { select: { id: true, title: true, teacherId: true, teacher: { select: nameSelect } } } },
          orderBy: { enrolledAt: 'asc' },
        },
      },
    });
    if (!student) throw new NotFoundException(msg('students.notFound'));

    const prev = previousPeriod(ctx.from, ctx.to);
    const prevBounds = periodBounds(prev.from, prev.to, ctx.timezone);
    const [head, rows, results, prevRows, prevResults] = await Promise.all([
      this.head(ctx, q),
      this.prisma.sessionAttendee.findMany({
        where: { studentId, session: this.sessionWhere(ctx, user, q) },
        select: { ...seatSelect, joinedAt: true, homework: true, progress: true, comment: true, session: { select: sessionSelect } },
        orderBy: { session: { startAt: 'asc' } },
      }),
      this.prisma.examResult.findMany({
        where: { studentId, exam: this.examWhere(ctx, user, q) },
        select: {
          score: true,
          feedback: true,
          gradedAt: true,
          exam: { select: { id: true, title: true, month: true, totalMarks: true, course: { select: { id: true, title: true } }, teacher: { select: nameSelect } } },
        },
        orderBy: [{ exam: { month: 'asc' } }, { gradedAt: 'asc' }],
      }),
      this.prisma.sessionAttendee.findMany({
        where: { studentId, session: { ...this.sessionWhere(ctx, user, q), startAt: { gte: prevBounds.start, lt: prevBounds.end } } },
        select: { ...seatSelect, session: { select: { status: true, startAt: true, endAt: true } } },
      }),
      this.prisma.examResult.findMany({
        where: { studentId, exam: this.examWhere({ ...ctx, ...prev }, user, q) },
        select: { score: true, exam: { select: { totalMarks: true } } },
      }),
    ]);

    // How the whole group did on the same exams, for comparison.
    const examIds = results.map((r) => r.exam.id);
    const groupScores = examIds.length
      ? await this.prisma.examResult.findMany({ where: { examId: { in: examIds } }, select: { examId: true, score: true } })
      : [];
    const scoresByExam = groupBy(groupScores, (r) => r.examId);

    const seats = rows.map((r) => seatOf(r.session, r));
    const summary = summarizeSeats(seats);
    const percents = results.map((r) => percentOf(Number(r.score), r.exam.totalMarks));
    const examAverage = round1(average(percents));
    const prevSummary = summarizeSeats(prevRows.map((r) => seatOf(r.session, r)));

    const sessions = rows.map((r, i) => ({
      id: r.session.id,
      title: r.session.title,
      status: r.session.status,
      startAt: r.session.startAt,
      endAt: r.session.endAt,
      minutes: seats[i].minutes,
      outcome: seats[i].outcome,
      joinedAt: r.joinedAt,
      teacher: { id: r.session.teacherId, name: r.session.teacher.user.fullName },
      course: r.session.course,
      rating: r.rating,
      progress: r.progress,
      homework: r.homework,
      comment: r.comment,
    }));

    const days = [...groupBy(sessions, (s) => dayKey(s.startAt, ctx.timezone))].map(([date, list]) => ({
      date,
      outcomes: list.map((s) => s.outcome),
    }));

    const courseGroups = groupBy(sessions, (s) => s.course?.id ?? null);
    const examsByCourse = groupBy(results, (r) => r.exam.course.id);
    const courses = [...courseGroups].map(([id, list]) => {
      const s = summarizeSeats(list.map((x) => seats[sessions.indexOf(x)]));
      const exams = id ? (examsByCourse.get(id) ?? []) : [];
      return {
        id,
        title: list[0].course?.title ?? null,
        teacher: list[0].teacher.name,
        ...pickSummary(s),
        examAverage: round1(average(exams.map((r) => percentOf(Number(r.score), r.exam.totalMarks)))),
      };
    });

    return {
      kind: 'student' as const,
      ...head,
      student: {
        id: student.id,
        name: student.user.fullName,
        email: student.user.email,
        phone: student.user.phone,
        grade: student.grade,
        parentPhone: student.parentPhone,
        status: student.membership.status as AccountStatus,
        memberSince: student.createdAt,
        teachers: student.teachers.map((t) => t.teacher.user.fullName).sort((a, b) => a.localeCompare(b)),
        courses: student.enrollments
          .filter((e) => ctx.viewer !== 'teacher' || e.course.teacherId === user.teacherId)
          .map((e) => ({ id: e.course.id, title: e.course.title, teacher: e.course.teacher.user.fullName, status: e.status, enrolledAt: e.enrolledAt })),
      },
      summary: {
        ...summary,
        sessions: sessions.length,
        homework: sessions.filter((s) => s.homework).length,
        exams: { count: results.length, average: examAverage },
      },
      previous: { from: prev.from, to: prev.to, attendanceRate: prevSummary.attendanceRate, averageRating: prevSummary.averageRating, examAverage: round1(average(prevResults.map((r) => percentOf(Number(r.score), r.exam.totalMarks)))) },
      flags: riskFlags({ tally: summary.counts, streak: summary.streak, examAverage, averageRating: summary.averageRating }),
      days,
      trend: this.trend(ctx, sessions.map((s, i) => ({ at: s.startAt, seats: [seats[i]], held: HELD.includes(seats[i].outcome), minutes: s.minutes }))),
      sessions,
      courses,
      exams: results.map((r, i) => {
        const group = (scoresByExam.get(r.exam.id) ?? []).map((g) => percentOf(Number(g.score), r.exam.totalMarks));
        return {
          id: r.exam.id,
          title: r.exam.title,
          month: r.exam.month.toISOString().slice(0, 7),
          course: r.exam.course,
          teacher: r.exam.teacher.user.fullName,
          score: Number(r.score),
          totalMarks: r.exam.totalMarks,
          percent: round1(percents[i])!,
          groupAverage: round1(average(group)),
          groupSize: group.length,
          feedback: r.feedback,
          gradedAt: r.gradedAt,
        };
      }),
      finance: q.finance && ctx.viewer === 'admin' ? await this.studentFinance(user, ctx, studentId, q) : null,
    };
  }

  // ───────── All students ─────────

  /** One line per student the viewer can see: attendance, ratings, exams and follow-up flags. */
  async students(user: JwtUser, q: ReportQueryDto) {
    const ctx = await this.context(user, q);
    const [head, rows] = await Promise.all([this.head(ctx, q), this.studentRows(ctx, user, q)]);
    const all = summarizeSeats(rows.flatMap((r) => r.seats));
    return {
      kind: 'students' as const,
      ...head,
      summary: {
        students: rows.length,
        active: rows.filter((r) => r.summary.held > 0).length,
        flagged: rows.filter((r) => r.flags.length > 0).length,
        ...pickSummary(all),
        examAverage: round1(average(rows.flatMap((r) => r.percents))),
      },
      students: rows.map(({ seats: _seats, percents: _percents, summary, ...r }) => ({ ...r, ...pickSummary(summary), streak: summary.streak })),
    };
  }

  /** Students who need attention, and held sessions still waiting for their evaluation. */
  async alerts(user: JwtUser, q: ReportQueryDto) {
    const ctx = await this.context(user, q);
    const [head, rows, pending] = await Promise.all([
      this.head(ctx, q),
      this.studentRows(ctx, user, q),
      this.prisma.session.findMany({
        where: { AND: [this.sessionWhere(ctx, user, q), { status: 'COMPLETED', attendees: { some: { status: null } } }] },
        select: { ...sessionSelect, attendees: { select: { status: true } } },
        orderBy: { startAt: 'desc' },
        take: 100,
      }),
    ]);
    const severity = (f: RiskFlag[]) => f.length + (f.includes('ABSENCE_STREAK') ? 1 : 0);
    return {
      kind: 'alerts' as const,
      ...head,
      students: rows
        .filter((r) => r.flags.length > 0)
        .sort((a, b) => severity(b.flags) - severity(a.flags) || (a.summary.attendanceRate ?? 1) - (b.summary.attendanceRate ?? 1) || byName(a, b))
        .map(({ seats: _seats, percents: _percents, summary, ...r }) => ({ ...r, ...pickSummary(summary), streak: summary.streak })),
      unevaluated: pending.map((s) => ({
        id: s.id,
        title: s.title,
        startAt: s.startAt,
        teacher: { id: s.teacherId, name: s.teacher.user.fullName },
        course: s.course,
        students: s.attendees.length,
        pending: s.attendees.filter((a) => a.status === null).length,
      })),
    };
  }

  // ───────── Attendance register ─────────

  /** Students × sessions: what each student did on each session of the period. */
  async register(user: JwtUser, q: ReportQueryDto) {
    const ctx = await this.context(user, q);
    const where = this.sessionWhere(ctx, user, q);
    const count = await this.prisma.session.count({ where });
    if (count > MAX_REGISTER_SESSIONS) throw new BadRequestException(msg('reports.tooManySessions', { max: MAX_REGISTER_SESSIONS, count }));
    const [head, sessions] = await Promise.all([this.head(ctx, q), this.sessionsWithSeats(where)]);

    const students = new Map<string, { id: string; name: string; cells: (Outcome | null)[]; seats: Seat[] }>();
    sessions.forEach((s, col) => {
      for (const a of s.attendees) {
        const row = students.get(a.studentId) ?? { id: a.studentId, name: a.student.user.fullName, cells: sessions.map(() => null), seats: [] };
        const seat = seatOf(s, a);
        row.cells[col] = seat.outcome;
        row.seats.push(seat);
        students.set(a.studentId, row);
      }
    });
    const rows = [...students.values()].sort(byName);
    return {
      kind: 'register' as const,
      ...head,
      summary: { sessions: sessions.length, students: rows.length, ...pickSummary(summarizeSeats(rows.flatMap((r) => r.seats))) },
      sessions: sessions.map((s) => {
        const summary = summarizeSeats(s.attendees.map((a) => seatOf(s, a)));
        return {
          id: s.id,
          title: s.title,
          status: s.status,
          startAt: s.startAt,
          day: dayKey(s.startAt, ctx.timezone),
          teacher: { id: s.teacherId, name: s.teacher.user.fullName },
          course: s.course,
          counts: summary.counts,
          attendanceRate: summary.attendanceRate,
        };
      }),
      students: rows.map((r) => ({ id: r.id, name: r.name, cells: r.cells, ...pickSummary(summarizeSeats(r.seats)) })),
    };
  }

  // ───────── Teachers ─────────

  async teachers(user: JwtUser, q: ReportQueryDto) {
    const ctx = await this.context(user, q);
    const teacherWhere: Prisma.TeacherWhereInput =
      ctx.viewer === 'teacher' ? { tenantId: ctx.tenantId, id: user.teacherId! } : { tenantId: ctx.tenantId, ...(q.teacherId ? { id: q.teacherId } : {}) };
    const [head, teachers, sessions] = await Promise.all([
      this.head(ctx, q),
      this.prisma.teacher.findMany({ where: teacherWhere, select: { id: true, ...nameSelect, _count: { select: { students: true } } }, orderBy: { user: { fullName: 'asc' } } }),
      this.sessionsWithSeats(this.sessionWhere(ctx, user, q)),
    ]);
    const byTeacher = groupBy(sessions, (s) => s.teacherId);
    const rows = teachers.map((t) => ({ id: t.id, name: t.user.fullName, linkedStudents: t._count.students, ...teacherStats(byTeacher.get(t.id) ?? []) }));
    return { kind: 'teachers' as const, ...head, summary: teacherStats(sessions), teachers: rows };
  }

  async teacher(user: JwtUser, teacherId: string, q: ReportQueryDto) {
    if (user.role === 'TEACHER' && teacherId !== user.teacherId) throw new NotFoundException(msg('teachers.notFound'));
    const ctx = await this.context(user, q);
    const teacher = await this.prisma.teacher.findFirst({
      where: { id: teacherId, tenantId: ctx.tenantId },
      select: {
        id: true,
        subjects: true,
        createdAt: true,
        user: { select: { fullName: true, email: true, phone: true } },
        membership: { select: { status: true } },
        _count: { select: { students: true, courses: true } },
      },
    });
    if (!teacher) throw new NotFoundException(msg('teachers.notFound'));

    const scoped = { ...q, teacherId };
    const [head, sessions, exams] = await Promise.all([
      this.head(ctx, scoped),
      this.sessionsWithSeats(this.sessionWhere(ctx, user, scoped)),
      this.prisma.exam.findMany({
        where: this.examWhere(ctx, user, scoped),
        select: { id: true, title: true, month: true, totalMarks: true, status: true, course: { select: { id: true, title: true } }, results: { select: { score: true } } },
        orderBy: { month: 'asc' },
      }),
    ]);

    const seatRows = sessions.flatMap((s) => s.attendees.map((a) => ({ a, seat: seatOf(s, a), course: s.course })));
    const students = [...groupBy(seatRows, (r) => r.a.studentId)].map(([id, list]) => ({
      id,
      name: list[0].a.student.user.fullName,
      ...pickSummary(summarizeSeats(list.map((r) => r.seat))),
    }));
    const courses = [...groupBy(sessions, (s) => s.course?.id ?? null)].map(([id, list]) => ({
      id,
      title: list[0].course?.title ?? null,
      ...teacherStats(list),
    }));

    return {
      kind: 'teacher' as const,
      ...head,
      teacher: {
        id: teacher.id,
        name: teacher.user.fullName,
        email: teacher.user.email,
        phone: teacher.user.phone,
        subjects: teacher.subjects,
        status: teacher.membership.status as AccountStatus,
        memberSince: teacher.createdAt,
        linkedStudents: teacher._count.students,
        courses: teacher._count.courses,
      },
      summary: teacherStats(sessions),
      trend: this.trend(ctx, sessions.map((s) => ({ at: s.startAt, seats: s.attendees.map((a) => seatOf(s, a)), held: isHeld(s.status), minutes: bookedMinutes(s) }))),
      students: students.sort(byName),
      courses,
      exams: exams.map((e) => examStats(e)),
      sessions: sessions.map((s) => {
        const summary = summarizeSeats(s.attendees.map((a) => seatOf(s, a)));
        return {
          id: s.id,
          title: s.title,
          status: s.status,
          startAt: s.startAt,
          endAt: s.endAt,
          minutes: bookedMinutes(s),
          actualMinutes: actualMinutes(s),
          delay: isHeld(s.status) ? startDelay(s) : null,
          course: s.course,
          students: s.attendees.length,
          counts: summary.counts,
          evaluated: s.status === 'COMPLETED' && s.attendees.length > 0 ? isEvaluated(s.attendees) : null,
        };
      }),
      pay: ctx.viewer === 'student' ? null : await this.teacherPay(user, ctx, teacherId, q),
    };
  }

  // ───────── Courses ─────────

  async courses(user: JwtUser, q: ReportQueryDto) {
    const ctx = await this.context(user, q);
    const courseWhere: Prisma.CourseWhereInput = {
      tenantId: ctx.tenantId,
      ...(ctx.viewer === 'teacher' ? { teacherId: user.teacherId! } : q.teacherId ? { teacherId: q.teacherId } : {}),
      ...(q.courseId ? { id: q.courseId } : {}),
    };
    const [head, courses, sessions, exams] = await Promise.all([
      this.head(ctx, q),
      this.prisma.course.findMany({
        where: courseWhere,
        select: { id: true, title: true, subject: true, isActive: true, teacher: { select: { id: true, ...nameSelect } }, enrollments: { select: { status: true } } },
        orderBy: { title: 'asc' },
      }),
      this.sessionsWithSeats({ ...this.sessionWhere(ctx, user, q), courseId: q.courseId ?? { not: null } }),
      this.prisma.exam.findMany({ where: this.examWhere(ctx, user, q), select: { courseId: true, totalMarks: true, results: { select: { score: true } } } }),
    ]);
    const sessionsByCourse = groupBy(sessions, (s) => s.courseId);
    const examsByCourse = groupBy(exams, (e) => e.courseId);
    return {
      kind: 'courses' as const,
      ...head,
      courses: courses.map((c) => {
        const list = sessionsByCourse.get(c.id) ?? [];
        const percents = (examsByCourse.get(c.id) ?? []).flatMap((e) => e.results.map((r) => percentOf(Number(r.score), e.totalMarks)));
        return {
          id: c.id,
          title: c.title,
          subject: c.subject,
          isActive: c.isActive,
          teacher: { id: c.teacher.id, name: c.teacher.user.fullName },
          enrollments: enrollmentCounts(c.enrollments),
          ...teacherStats(list),
          examAverage: round1(average(percents)),
          examResults: percents.length,
        };
      }),
    };
  }

  async course(user: JwtUser, courseId: string, q: ReportQueryDto) {
    const ctx = await this.context(user, q);
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId: ctx.tenantId, ...(ctx.viewer === 'teacher' ? { teacherId: user.teacherId! } : {}) },
      select: {
        id: true,
        title: true,
        subject: true,
        level: true,
        isActive: true,
        teacher: { select: { id: true, ...nameSelect } },
        enrollments: { select: { status: true, enrolledAt: true, student: { select: { id: true, ...nameSelect } } } },
      },
    });
    if (!course) throw new NotFoundException(msg('sessions.courseNotFound'));

    const scoped = { ...q, courseId };
    const [head, sessions, exams] = await Promise.all([
      this.head(ctx, scoped),
      this.sessionsWithSeats(this.sessionWhere(ctx, user, scoped)),
      this.prisma.exam.findMany({
        where: this.examWhere(ctx, user, scoped),
        select: { id: true, title: true, month: true, totalMarks: true, status: true, course: { select: { id: true, title: true } }, results: { select: { studentId: true, score: true } } },
        orderBy: { month: 'asc' },
      }),
    ]);

    const people = new Map<string, { id: string; name: string; enrollment: EnrollmentStatus | null; seats: Seat[]; percents: number[] }>();
    const person = (id: string, name: string) => {
      const p = people.get(id) ?? { id, name, enrollment: null, seats: [], percents: [] };
      people.set(id, p);
      return p;
    };
    for (const e of course.enrollments) person(e.student.id, e.student.user.fullName).enrollment = e.status;
    for (const s of sessions) for (const a of s.attendees) person(a.studentId, a.student.user.fullName).seats.push(seatOf(s, a));
    for (const e of exams) {
      for (const r of e.results) people.get(r.studentId)?.percents.push(percentOf(Number(r.score), e.totalMarks));
    }

    const allPercents = exams.flatMap((e) => e.results.map((r) => percentOf(Number(r.score), e.totalMarks)));
    return {
      kind: 'course' as const,
      ...head,
      course: {
        id: course.id,
        title: course.title,
        subject: course.subject,
        level: course.level,
        isActive: course.isActive,
        teacher: { id: course.teacher.id, name: course.teacher.user.fullName },
        enrollments: enrollmentCounts(course.enrollments),
      },
      summary: { ...teacherStats(sessions), examAverage: round1(average(allPercents)), examResults: allPercents.length },
      trend: this.trend(ctx, sessions.map((s) => ({ at: s.startAt, seats: s.attendees.map((a) => seatOf(s, a)), held: isHeld(s.status), minutes: bookedMinutes(s) }))),
      sessions: sessions.map((s) => {
        const summary = summarizeSeats(s.attendees.map((a) => seatOf(s, a)));
        return { id: s.id, title: s.title, status: s.status, startAt: s.startAt, minutes: bookedMinutes(s), students: s.attendees.length, counts: summary.counts, attendanceRate: summary.attendanceRate };
      }),
      exams: exams.map((e) => examStats(e)),
      students: [...people.values()]
        .map((p) => {
          const summary = summarizeSeats(p.seats);
          const examAverage = round1(average(p.percents));
          return {
            id: p.id,
            name: p.name,
            enrollment: p.enrollment,
            ...pickSummary(summary),
            examAverage,
            flags: riskFlags({ tally: summary.counts, streak: summary.streak, examAverage, averageRating: summary.averageRating }),
          };
        })
        .sort(byName),
    };
  }

  // ───────── The center ─────────

  /** Admins: the center over the period, next to the period before it. */
  async center(user: JwtUser, q: ReportQueryDto) {
    const ctx = await this.context(user, q);
    const prev = previousPeriod(ctx.from, ctx.to);
    const prevCtx = { ...ctx, ...prev, ...periodBounds(prev.from, prev.to, ctx.timezone) };
    const [head, current, previous, rows] = await Promise.all([
      this.head(ctx, q),
      this.centerFigures(user, ctx, q),
      this.centerFigures(user, prevCtx, q),
      this.studentRows(ctx, user, q),
    ]);
    const sessions = current.sessions;
    const teachers = [...groupBy(sessions, (s) => s.teacherId)].map(([id, list]) => ({ id, name: list[0].teacher.user.fullName, ...teacherStats(list) }));
    const courses = [...groupBy(sessions.filter((s) => s.course), (s) => s.courseId)].map(([id, list]) => ({
      id: id!,
      title: list[0].course!.title,
      teacher: list[0].teacher.user.fullName,
      ...teacherStats(list),
    }));
    return {
      kind: 'center' as const,
      ...head,
      previous: { from: prev.from, to: prev.to },
      kpis: { ...current.kpis, flaggedStudents: rows.filter((r) => r.flags.length > 0).length },
      previousKpis: previous.kpis,
      finance: current.finance,
      previousFinance: previous.finance,
      trend: this.trend(ctx, sessions.map((s) => ({ at: s.startAt, seats: s.attendees.map((a) => seatOf(s, a)), held: isHeld(s.status), minutes: bookedMinutes(s) }))),
      teachers: teachers.sort((a, b) => b.heldMinutes - a.heldMinutes || byName(a, b)),
      courses: courses.sort((a, b) => b.held - a.held || a.title.localeCompare(b.title)),
      atRisk: rows
        .filter((r) => r.flags.length > 0)
        .sort((a, b) => b.flags.length - a.flags.length || (a.summary.attendanceRate ?? 1) - (b.summary.attendanceRate ?? 1))
        .slice(0, 10)
        .map((r) => ({ id: r.id, name: r.name, flags: r.flags, attendanceRate: r.summary.attendanceRate, streak: r.summary.streak, examAverage: r.examAverage })),
    };
  }

  // ───────── helpers ─────────

  private async context(user: JwtUser, q: { from: string; to: string }): Promise<Ctx> {
    if (!isRealDay(q.from) || !isRealDay(q.to)) throw new BadRequestException(msg('reports.invalidDate'));
    if (q.from > q.to) throw new BadRequestException(msg('reports.invalidRange'));
    if (dayCount(q.from, q.to) > MAX_DAYS) throw new BadRequestException(msg('reports.rangeTooLong', { days: MAX_DAYS }));
    const tenantId = user.tenantId!;
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, timezone: true, currency: true, logoKey: true } });
    const viewer: Viewer = user.role === 'STUDENT' ? 'student' : user.role === 'TEACHER' ? 'teacher' : 'admin';
    return {
      tenantId,
      viewer,
      from: q.from,
      to: q.to,
      days: dayCount(q.from, q.to),
      timezone: tenant.timezone,
      ...periodBounds(q.from, q.to, tenant.timezone),
      center: { name: tenant.name, currency: tenant.currency },
      logoKey: tenant.logoKey,
    };
  }

  /** The head every report shares, with the names of the teacher and course it was narrowed to. */
  private async head(ctx: Ctx, q: { teacherId?: string; courseId?: string }): Promise<ReportHead> {
    const [teacher, course] = await Promise.all([
      q.teacherId ? this.prisma.teacher.findFirst({ where: { id: q.teacherId, tenantId: ctx.tenantId }, select: { id: true, ...nameSelect } }) : null,
      q.courseId ? this.prisma.course.findFirst({ where: { id: q.courseId, tenantId: ctx.tenantId }, select: { id: true, title: true } }) : null,
    ]);
    return {
      generatedAt: new Date().toISOString(),
      period: { from: ctx.from, to: ctx.to, days: ctx.days, timezone: ctx.timezone },
      center: ctx.center,
      filters: { teacher: teacher ? { id: teacher.id, name: teacher.user.fullName } : null, course },
    };
  }

  /** The logo to print on this center's reports. */
  async logoKey(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { logoKey: true } });
    return t?.logoKey ?? null;
  }

  /** Students the viewer may report on: teachers see the ones they teach, students themselves. */
  private studentWhere(user: JwtUser): Prisma.StudentWhereInput {
    const tenantId = user.tenantId!;
    if (user.role === 'STUDENT') return { tenantId, id: user.studentId! };
    if (user.role === 'TEACHER') {
      const teacherId = user.teacherId!;
      return {
        tenantId,
        OR: [
          { teachers: { some: { teacherId } } },
          { enrollments: { some: { course: { teacherId } } } },
          { attendances: { some: { session: { teacherId } } } },
        ],
      };
    }
    return { tenantId };
  }

  /** Sessions of the period the viewer may count: a teacher only their own. */
  private sessionWhere(ctx: Pick<Ctx, 'tenantId' | 'start' | 'end'>, user: JwtUser, q: { teacherId?: string; courseId?: string }): Prisma.SessionWhereInput {
    const teacherId = user.role === 'TEACHER' ? user.teacherId! : q.teacherId;
    return {
      tenantId: ctx.tenantId,
      startAt: { gte: ctx.start, lt: ctx.end },
      ...(teacherId ? { teacherId } : {}),
      ...(q.courseId ? { courseId: q.courseId } : {}),
      ...(user.role === 'STUDENT' ? { attendees: { some: { studentId: user.studentId! } } } : {}),
    };
  }

  /** Published exams filed under the months the period touches. Drafts never count. */
  private examWhere(ctx: Pick<Ctx, 'tenantId' | 'from' | 'to'>, user: JwtUser, q: { teacherId?: string; courseId?: string }): Prisma.ExamWhereInput {
    const teacherId = user.role === 'TEACHER' ? user.teacherId! : q.teacherId;
    return {
      tenantId: ctx.tenantId,
      status: { not: 'DRAFT' },
      month: { in: monthStarts(ctx.from, ctx.to).map((d) => new Date(`${d}T00:00:00Z`)) },
      ...(teacherId ? { teacherId } : {}),
      ...(q.courseId ? { courseId: q.courseId } : {}),
    };
  }

  private sessionsWithSeats(where: Prisma.SessionWhereInput): Promise<SessionWithSeats[]> {
    return this.prisma.session.findMany({
      where,
      select: {
        ...sessionSelect,
        attendees: { select: { ...seatSelect, student: { select: nameSelect } }, orderBy: { student: { user: { fullName: 'asc' } } } },
      },
      orderBy: { startAt: 'asc' },
    });
  }

  /** Per visible student: their seats and exam scores over the period, summarized and flagged. */
  private async studentRows(ctx: Ctx, user: JwtUser, q: ReportQueryDto) {
    const students = await this.prisma.student.findMany({
      where: this.studentWhere(user),
      select: { id: true, grade: true, ...nameSelect, membership: { select: { status: true } } },
      orderBy: { user: { fullName: 'asc' } },
    });
    const ids = students.map((s) => s.id);
    if (ids.length === 0) return [];
    const [seats, results] = await Promise.all([
      this.prisma.sessionAttendee.findMany({
        where: { studentId: { in: ids }, session: this.sessionWhere(ctx, user, q) },
        select: { ...seatSelect, session: { select: { status: true, startAt: true, endAt: true } } },
      }),
      this.prisma.examResult.findMany({
        where: { studentId: { in: ids }, exam: this.examWhere(ctx, user, q) },
        select: { studentId: true, score: true, exam: { select: { totalMarks: true } } },
      }),
    ]);
    const seatsOf = groupBy(seats, (a) => a.studentId);
    const resultsOf = groupBy(results, (r) => r.studentId);
    const narrowed = Boolean(q.teacherId || q.courseId);
    return students
      .map((s) => {
        const list = (seatsOf.get(s.id) ?? []).map((a) => seatOf(a.session, a));
        const percents = (resultsOf.get(s.id) ?? []).map((r) => percentOf(Number(r.score), r.exam.totalMarks));
        const summary = summarizeSeats(list);
        const examAverage = round1(average(percents));
        return {
          id: s.id,
          name: s.user.fullName,
          grade: s.grade,
          status: s.membership.status as AccountStatus,
          seats: list,
          percents,
          summary,
          examAverage,
          exams: percents.length,
          flags: riskFlags({ tally: summary.counts, streak: summary.streak, examAverage, averageRating: summary.averageRating }),
        };
      })
      // Narrowed to a teacher or course, only the students who have something there.
      .filter((r) => !narrowed || r.seats.length > 0 || r.percents.length > 0);
  }

  private async centerFigures(user: JwtUser, ctx: Ctx, q: ReportQueryDto) {
    const where = this.sessionWhere(ctx, user, q);
    const [sessions, students, newStudents, teachers, exams] = await Promise.all([
      this.sessionsWithSeats(where),
      this.prisma.student.count({ where: { tenantId: ctx.tenantId, createdAt: { lt: ctx.end } } }),
      this.prisma.student.count({ where: { tenantId: ctx.tenantId, createdAt: { gte: ctx.start, lt: ctx.end } } }),
      this.prisma.teacher.count({ where: { tenantId: ctx.tenantId, createdAt: { lt: ctx.end } } }),
      this.prisma.exam.findMany({ where: this.examWhere(ctx, user, q), select: { totalMarks: true, results: { select: { score: true } } } }),
    ]);
    const heldSessions = sessions.filter((s) => isHeld(s.status));
    const percents = exams.flatMap((e) => e.results.map((r) => percentOf(Number(r.score), e.totalMarks)));
    const stats = teacherStats(sessions);
    return {
      sessions,
      kpis: {
        ...stats,
        /** Students on the center's books by the end of the period. */
        students,
        newStudents,
        activeStudents: new Set(heldSessions.flatMap((s) => s.attendees.map((a) => a.studentId))).size,
        teachers,
        activeTeachers: new Set(heldSessions.map((s) => s.teacherId)).size,
        examAverage: round1(average(percents)),
        examResults: percents.length,
      },
      finance: await this.centerFinance(user, ctx, q),
    };
  }

  /** Points for a trend chart: held sessions, teaching time and attendance per day, week or month. */
  private trend(ctx: Pick<Ctx, 'from' | 'to' | 'timezone'>, items: { at: Date; seats: Seat[]; held: boolean; minutes: number }[]) {
    const { unit, list } = buckets(ctx.from, ctx.to);
    const keyed = items.map((i) => ({ ...i, day: dayKey(i.at, ctx.timezone) }));
    return {
      unit,
      points: list.map((b) => {
        const inside = keyed.filter((i) => i.day >= b.from && i.day <= b.to);
        const summary = summarizeSeats(inside.flatMap((i) => i.seats));
        return {
          from: b.from,
          to: b.to,
          sessions: inside.filter((i) => i.held).length,
          minutes: inside.reduce((n, i) => n + (i.held ? i.minutes : 0), 0),
          counts: summary.counts,
          attendanceRate: summary.attendanceRate,
        };
      }),
    };
  }

  private summaryQuery(ctx: Ctx, q: { teacherId?: string; courseId?: string; studentId?: string }, groupBy: BillingSummaryQueryDto['groupBy']) {
    return { from: ctx.start.toISOString(), to: ctx.end.toISOString(), teacherId: q.teacherId, courseId: q.courseId, studentId: q.studentId, groupBy } as BillingSummaryQueryDto;
  }

  private async studentFinance(user: JwtUser, ctx: Ctx, studentId: string, q: ReportQueryDto) {
    const s = await this.billing.summary(user, this.summaryQuery(ctx, { ...q, studentId }, 'course'));
    return {
      currency: s.currency,
      sessions: s.totals.chargedSessions,
      minutes: s.totals.studentMinutes,
      fees: s.totals.fees,
      missingRates: s.totals.missingRates,
      courses: s.groups.map((g) => ({ id: g.key === 'none' ? null : g.key, title: g.label, sessions: g.sessions, minutes: g.minutes, fees: g.fees })),
    };
  }

  /** What the teacher earned over the period: admins and the teacher themselves. */
  private async teacherPay(user: JwtUser, ctx: Ctx, teacherId: string, q: ReportQueryDto) {
    const s = await this.billing.summary(user, this.summaryQuery(ctx, { ...q, teacherId }, 'month'));
    return {
      currency: s.currency,
      sessions: s.totals.chargedSessions,
      minutes: s.totals.minutes,
      teacherPay: s.totals.teacherPay ?? 0,
      ...(ctx.viewer === 'admin' ? { fees: s.totals.fees } : {}),
    };
  }

  private async centerFinance(user: JwtUser, ctx: Ctx, q: ReportQueryDto) {
    if (ctx.viewer !== 'admin') return null;
    const s = await this.billing.summary(user, this.summaryQuery(ctx, q, 'month'));
    return {
      currency: s.currency,
      fees: s.totals.fees,
      teacherPay: s.totals.teacherPay ?? 0,
      platformFee: s.totals.platformFee ?? null,
      net: s.totals.net ?? null,
      missingRates: s.totals.missingRates,
    };
  }
}

/** The parts of a seat summary that reports show (absence runs are added where they matter). */
function pickSummary(s: SeatSummary) {
  return {
    counts: s.counts,
    held: s.held,
    attendanceRate: s.attendanceRate,
    punctualityRate: s.punctualityRate,
    heldMinutes: s.heldMinutes,
    attendedMinutes: s.attendedMinutes,
    averageRating: s.averageRating,
  };
}

function enrollmentCounts(list: { status: EnrollmentStatus }[]) {
  return {
    active: list.filter((e) => e.status === 'ACTIVE').length,
    completed: list.filter((e) => e.status === 'COMPLETED').length,
    dropped: list.filter((e) => e.status === 'DROPPED').length,
  };
}

/** A teacher's (or a course's) sessions: what was held, on time, evaluated, and how students attended. */
function teacherStats(sessions: SessionWithSeats[]) {
  const status = (s: SessionStatus) => sessions.filter((x) => x.status === s).length;
  const heldSessions = sessions.filter((s) => isHeld(s.status));
  const delays = heldSessions.map(startDelay).filter((d): d is number => d !== null);
  const actual = heldSessions.map(actualMinutes).filter((m): m is number => m !== null);
  const due = sessions.filter((s) => s.status === 'COMPLETED' && s.attendees.length > 0);
  const evaluated = due.filter((s) => isEvaluated(s.attendees)).length;
  const seats = summarizeSeats(sessions.flatMap((s) => s.attendees.map((a) => seatOf(s, a))));
  return {
    sessions: sessions.length,
    held: heldSessions.length,
    upcoming: status('SCHEDULED'),
    live: status('LIVE'),
    completed: status('COMPLETED'),
    canceled: status('CANCELED'),
    missed: status('MISSED'),
    heldMinutes: heldSessions.reduce((n, s) => n + bookedMinutes(s), 0),
    actualMinutes: actual.length ? actual.reduce((a, b) => a + b, 0) : null,
    startsRecorded: delays.length,
    onTime: delays.filter((d) => d <= ON_TIME_GRACE_MIN).length,
    onTimeRate: delays.length ? delays.filter((d) => d <= ON_TIME_GRACE_MIN).length / delays.length : null,
    averageDelay: round1(average(delays.filter((d) => d > ON_TIME_GRACE_MIN))),
    evaluationsDue: due.length,
    evaluated,
    evaluationRate: due.length ? evaluated / due.length : null,
    students: new Set(sessions.flatMap((s) => s.attendees.map((a) => a.studentId))).size,
    counts: seats.counts,
    attendanceRate: seats.attendanceRate,
    averageRating: seats.averageRating,
  };
}

function examStats(e: { id: string; title: string; month: Date; totalMarks: number; status: string; course: { id: string; title: string }; results: { score: Prisma.Decimal }[] }) {
  const percents = e.results.map((r) => percentOf(Number(r.score), e.totalMarks));
  return {
    id: e.id,
    title: e.title,
    month: e.month.toISOString().slice(0, 7),
    status: e.status,
    course: e.course,
    totalMarks: e.totalMarks,
    results: percents.length,
    average: round1(average(percents)),
    highest: percents.length ? round1(Math.max(...percents)) : null,
    lowest: percents.length ? round1(Math.min(...percents)) : null,
    distribution: distribution(percents),
  };
}

export type StudentReport = Awaited<ReturnType<ReportsService['student']>>;
export type StudentsReport = Awaited<ReturnType<ReportsService['students']>>;
export type AlertsReport = Awaited<ReturnType<ReportsService['alerts']>>;
export type RegisterReport = Awaited<ReturnType<ReportsService['register']>>;
export type TeachersReport = Awaited<ReturnType<ReportsService['teachers']>>;
export type TeacherReport = Awaited<ReturnType<ReportsService['teacher']>>;
export type CoursesReport = Awaited<ReturnType<ReportsService['courses']>>;
export type CourseReport = Awaited<ReturnType<ReportsService['course']>>;
export type CenterReport = Awaited<ReturnType<ReportsService['center']>>;
