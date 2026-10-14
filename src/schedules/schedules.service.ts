import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { findClashes, lockPeople, type People } from '../sessions/session-clashes.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { CreateScheduleDto, PreviewScheduleDto } from './dto/schedule.dto.js';
import {
  MAX_SESSIONS,
  type Occurrence,
  type Slot,
  periodEnd,
  planProblem,
  planSessions,
  sessionLength,
} from './schedule-plan.js';
import { msg } from '../i18n/i18n.js';

const scheduleInclude = {
  teacher: { select: { id: true, user: { select: { fullName: true } } } },
  student: { select: { id: true, user: { select: { fullName: true } } } },
  course: { select: { id: true, title: true } },
  slots: { select: { weekday: true, startTime: true }, orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }] },
  sessions: { select: { status: true, startAt: true, endAt: true } },
} satisfies Prisma.StudentScheduleInclude;

type PlanInput = Pick<CreateScheduleDto, 'monthlyHours' | 'weeklyHours' | 'startDate' | 'slots'>;

@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  async list(user: JwtUser) {
    const rows = await this.prisma.studentSchedule.findMany({
      where: { tenantId: user.tenantId!, ...(user.role === 'TEACHER' ? { teacherId: user.teacherId! } : {}) },
      include: scheduleInclude,
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
    });
    // A suspended teacher reads their schedules but not the meeting link (see SessionsService.forViewer).
    return rows.map((r) => (user.status === 'SUSPENDED' ? { ...summarize(r), meetingUrl: null } : summarize(r)));
  }

  /** Lays out the month without saving, flagging sessions that clash with the teacher's or student's. */
  async preview(user: JwtUser, dto: PreviewScheduleDto) {
    const teacher = await this.teacherFor(user, dto.teacherId);
    const student = dto.studentId ? await this.studentFor(user, teacher.id, dto.studentId) : null;
    const plan = this.plan(dto, teacher.tenant.timezone);
    const people = { teacherId: teacher.id, studentIds: student ? [student.id] : [] };
    const clashes = await findClashes(this.prisma, user.tenantId!, people, plan.occurrences);
    return {
      ...plan,
      occurrences: plan.occurrences.map((o, i) => ({ ...o, conflict: clashes[i] !== null })),
    };
  }

  /** Saves the schedule and creates every session of the period (with a meeting each, for Zoom / Meet). */
  async create(user: JwtUser, dto: CreateScheduleDto) {
    const tenantId = user.tenantId!;
    if (dto.provider === 'MANUAL' && !dto.meetingUrl) throw new BadRequestException(msg('sessions.manualNeedsUrl'));
    const teacher = await this.teacherFor(user, dto.teacherId);
    const student = await this.studentFor(user, teacher.id, dto.studentId);
    if (dto.courseId) {
      const course = await this.prisma.course.findFirst({ where: { id: dto.courseId, tenantId, teacherId: teacher.id } });
      if (!course) throw new NotFoundException(msg('sessions.courseNotFound'));
    }
    const plan = this.plan(dto, teacher.tenant.timezone);
    const people = { teacherId: teacher.id, studentIds: [student.id] };
    // Refused before any meeting is made; checked again under a lock when saving.
    await this.assertFree(this.prisma, tenantId, people, plan.occurrences);
    const meetingUrl = dto.provider === 'MANUAL' ? dto.meetingUrl : undefined;

    // One meeting per session on the teacher's account; undone if anything later fails.
    const meetings: { joinUrl?: string; externalMeetingId?: string }[] = [];
    try {
      for (const o of plan.occurrences) {
        meetings.push(
          dto.provider === 'MANUAL'
            ? { joinUrl: meetingUrl }
            : await this.sessions.providerFor(dto.provider).createMeeting({
                hostUserId: teacher.userId,
                title: dto.title,
                startAt: o.startAt,
                endAt: o.endAt,
                timezone: teacher.tenant.timezone,
                attendeeEmails: [student.user.email],
              }),
        );
      }

      const created = await this.prisma.$transaction(async (tx) => {
        await lockPeople(tx, people);
        await this.assertFree(tx, tenantId, people, plan.occurrences);
        // An admin may schedule any student; the teacher then sees them in their list.
        await tx.teacherStudent.upsert({
          where: { teacherId_studentId: { teacherId: teacher.id, studentId: student.id } },
          update: {},
          create: { teacherId: teacher.id, studentId: student.id },
        });
        return tx.studentSchedule.create({
          data: {
            tenantId,
            teacherId: teacher.id,
            studentId: student.id,
            courseId: dto.courseId,
            title: dto.title,
            provider: dto.provider,
            meetingUrl,
            monthlyMinutes: plan.monthlyMinutes,
            weeklyMinutes: plan.weeklyMinutes,
            startDate: new Date(plan.startDate),
            endDate: new Date(plan.endDate),
            slots: { create: dto.slots.map((s) => ({ weekday: s.weekday, startTime: s.startTime })) },
            sessions: {
              create: plan.occurrences.map((o, i) => ({
                tenantId,
                teacherId: teacher.id,
                courseId: dto.courseId,
                title: dto.title,
                provider: dto.provider,
                startAt: o.startAt,
                endAt: o.endAt,
                meetingUrl: meetings[i].joinUrl,
                externalMeetingId: meetings[i].externalMeetingId,
                attendees: { create: { studentId: student.id } },
              })),
            },
          },
          include: scheduleInclude,
        });
      });
      return summarize(created);
    } catch (err) {
      if (dto.provider !== 'MANUAL') {
        for (const m of meetings) {
          if (m.externalMeetingId) await this.sessions.deleteExternal(dto.provider, teacher.userId, m.externalMeetingId);
        }
      }
      throw err;
    }
  }

  /** The next month with the same hours and slots, starting where this one ends (or today, if later). */
  async renew(user: JwtUser, id: string) {
    const s = await this.getOwned(user, id);
    const today = localToday(s.tenant.timezone);
    const end = dateOnly(s.endDate);
    return this.create(user, {
      teacherId: s.teacherId,
      studentId: s.studentId,
      courseId: s.courseId ?? undefined,
      title: s.title,
      provider: s.provider,
      meetingUrl: s.meetingUrl ?? undefined,
      monthlyHours: s.monthlyMinutes / 60,
      weeklyHours: s.weeklyMinutes / 60,
      startDate: end > today ? end : today,
      slots: s.slots,
    });
  }

  /** Deletes the schedule and its sessions still to come; past sessions stay (unlinked) for billing and reports. */
  async remove(user: JwtUser, id: string) {
    const s = await this.getOwned(user, id);
    const upcoming = await this.prisma.session.findMany({
      where: { scheduleId: id, status: 'SCHEDULED', startAt: { gt: new Date() } },
      select: { id: true, provider: true, externalMeetingId: true },
    });
    for (const u of upcoming) {
      if (u.externalMeetingId && u.provider !== 'MANUAL') {
        await this.sessions.deleteExternal(u.provider, s.teacher.userId, u.externalMeetingId);
      }
    }
    await this.prisma.$transaction([
      this.prisma.session.deleteMany({ where: { id: { in: upcoming.map((u) => u.id) } } }),
      this.prisma.studentSchedule.delete({ where: { id } }),
    ]);
  }

  // ───────── helpers ─────────

  private plan(dto: PlanInput, timeZone: string) {
    const monthlyMinutes = Math.round(dto.monthlyHours * 60);
    const weeklyMinutes = Math.round(dto.weeklyHours * 60);
    const slots: Slot[] = dto.slots.map((s) => ({ weekday: s.weekday, startTime: s.startTime }));
    const problem = planProblem({ monthlyMinutes, weeklyMinutes, slots });
    if (problem) throw new BadRequestException(msg(problem.key, problem.params));

    const endDate = periodEnd(dto.startDate);
    const occurrences = planSessions({
      startDate: dto.startDate,
      endDate,
      slots,
      weeklyMinutes,
      monthlyMinutes,
      timeZone,
    });
    if (occurrences.length === 0) throw new BadRequestException(msg('schedules.nothingToSchedule'));
    if (occurrences.length > MAX_SESSIONS) {
      throw new BadRequestException(msg('schedules.tooManySessions', { max: MAX_SESSIONS }));
    }
    return {
      startDate: dto.startDate,
      endDate,
      timeZone,
      monthlyMinutes,
      weeklyMinutes,
      sessionMinutes: sessionLength(weeklyMinutes, slots.length),
      totalMinutes: occurrences.reduce((sum, o) => sum + minutesBetween(o), 0),
      occurrences,
    };
  }

  /** Every session of the period must fit both the teacher's and the student's other sessions. */
  private async assertFree(db: Parameters<typeof findClashes>[0], tenantId: string, people: People, occ: Occurrence[]) {
    const clashes = await findClashes(db, tenantId, people, occ);
    const count = clashes.filter(Boolean).length;
    if (count > 0) throw new ConflictException(msg('schedules.clash', { count }));
  }

  private async teacherFor(user: JwtUser, teacherId: string | undefined) {
    const id = user.role === 'TEACHER' ? user.teacherId! : teacherId;
    if (!id) throw new BadRequestException(msg('teachers.required'));
    const teacher = await this.prisma.teacher.findFirst({
      where: { id, tenantId: user.tenantId! },
      select: { id: true, userId: true, tenant: { select: { timezone: true } } },
    });
    if (!teacher) throw new NotFoundException(msg('teachers.notFound'));
    return teacher;
  }

  /** Teachers may only schedule their own students; admins any student of the center. */
  private async studentFor(user: JwtUser, teacherId: string, studentId: string) {
    const student = await this.prisma.student.findFirst({
      where: {
        id: studentId,
        tenantId: user.tenantId!,
        ...(user.role === 'TEACHER' ? { teachers: { some: { teacherId } } } : {}),
      },
      select: { id: true, user: { select: { email: true } } },
    });
    if (!student) throw new NotFoundException(msg('students.notFound'));
    return student;
  }

  private async getOwned(user: JwtUser, id: string) {
    const s = await this.prisma.studentSchedule.findFirst({
      where: { id, tenantId: user.tenantId! },
      include: {
        slots: { select: { weekday: true, startTime: true } },
        teacher: { select: { userId: true } },
        tenant: { select: { timezone: true } },
      },
    });
    if (!s) throw new NotFoundException(msg('schedules.notFound'));
    if (user.role === 'TEACHER' && s.teacherId !== user.teacherId) throw new ForbiddenException();
    return s;
  }
}

type ScheduleRow = {
  startDate: Date;
  endDate: Date;
  sessions: { status: string; startAt: Date; endAt: Date }[];
};

/** Dates as YYYY-MM-DD, and how much of the month is booked, held and still to come. */
function summarize<T extends ScheduleRow>(row: T, now = new Date()) {
  const { sessions, ...rest } = row;
  const live = sessions.filter((s) => s.status !== 'CANCELED');
  return {
    ...rest,
    startDate: dateOnly(row.startDate),
    endDate: dateOnly(row.endDate),
    stats: {
      sessions: live.length,
      scheduledMinutes: live.reduce((sum, s) => sum + minutesBetween(s), 0),
      completedMinutes: live.filter((s) => s.status === 'COMPLETED').reduce((sum, s) => sum + minutesBetween(s), 0),
      upcoming: live.filter((s) => s.status === 'SCHEDULED' && s.startAt > now).length,
    },
  };
}

const minutesBetween = (o: { startAt: Date; endAt: Date }) => Math.round((o.endAt.getTime() - o.startAt.getTime()) / 60_000);
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const localToday = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
