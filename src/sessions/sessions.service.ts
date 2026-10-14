import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { CreateSessionDto, EvaluateSessionDto, UpdateSessionDto } from './dto/session.dto.js';
import { evaluationRow } from './session-evaluation.js';
import { ZoomProvider } from './providers/zoom.provider.js';
import { GoogleMeetProvider } from './providers/google-meet.provider.js';
import type { MeetingProvider } from './providers/meeting-provider.interface.js';
import type { SessionProvider } from '../generated/prisma/enums.js';
import {
  EARLY_ENTRY_MIN,
  canDelete,
  canReschedule,
  entryWindow,
  isOpen,
  nextStatus,
  overdueCutoffs,
  unstartedOutcome,
} from './session-lifecycle.js';
import { msg } from '../i18n/i18n.js';
import { assertFree, lockPeople } from './session-clashes.js';

const sessionInclude = {
  teacher: { select: { id: true, userId: true, user: { select: { fullName: true } } } },
  course: { select: { id: true, title: true } },
  _count: { select: { attendees: true } },
} as const;

const SWEEP_EVERY_MS = 5 * 60_000;
const PROVIDERS: SessionProvider[] = ['ZOOM', 'GOOGLE_MEET', 'MANUAL'];

@Injectable()
export class SessionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionsService.name);
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly zoom: ZoomProvider,
    private readonly google: GoogleMeetProvider,
  ) {}

  onModuleInit() {
    void this.closeOverdue();
    this.sweeper = setInterval(() => void this.closeOverdue(), SWEEP_EVERY_MS);
    this.sweeper.unref();
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
  }

  /** Zoom tells us when meetings really start and end only if its webhook is set up. */
  get zoomEventsEnabled() {
    return Boolean(this.config.get('ZOOM_WEBHOOK_SECRET_TOKEN'));
  }

  async list(user: JwtUser, range?: { from?: Date; to?: Date }) {
    const tenantId = user.tenantId!;
    const scope =
      user.role === 'TEACHER'
        ? { teacherId: user.teacherId! }
        : user.role === 'STUDENT'
          ? { attendees: { some: { studentId: user.studentId! } } }
          : {};
    const rows = await this.prisma.session.findMany({
      where: {
        tenantId,
        ...scope,
        ...(range?.from || range?.to ? { startAt: { gte: range.from, lte: range.to } } : {}),
      },
      include: sessionInclude,
      orderBy: { startAt: 'desc' },
    });
    return rows.map((s) => this.forViewer(user, s));
  }

  async get(user: JwtUser, id: string) {
    const session = await this.prisma.session.findFirst({
      where: { id, tenantId: user.tenantId! },
      include: {
        ...sessionInclude,
        attendees: {
          // A student sees only their own attendance and evaluation, never classmates'.
          where: user.role === 'STUDENT' ? { studentId: user.studentId! } : {},
          include: { student: { select: { id: true, user: { select: { fullName: true } } } } },
          orderBy: { student: { user: { fullName: 'asc' } } },
        },
      },
    });
    if (!session) throw new NotFoundException(msg('sessions.notFound'));
    if (user.role === 'TEACHER' && session.teacherId !== user.teacherId) throw new ForbiddenException();
    if (user.role === 'STUDENT' && !session.attendees.some((a) => a.studentId === user.studentId)) {
      throw new ForbiddenException();
    }
    return this.forViewer(user, session);
  }

  async create(user: JwtUser, dto: CreateSessionDto) {
    const tenantId = user.tenantId!;
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    if (endAt <= startAt) throw new BadRequestException(msg('sessions.endBeforeStart'));
    if (dto.provider === 'MANUAL' && !dto.meetingUrl) throw new BadRequestException(msg('sessions.manualNeedsUrl'));

    const teacherId = user.role === 'TEACHER' ? user.teacherId! : dto.teacherId;
    if (!teacherId) throw new BadRequestException(msg('teachers.required'));
    const teacher = await this.prisma.teacher.findFirst({
      where: { id: teacherId, tenantId },
      include: { user: { select: { id: true } }, tenant: { select: { timezone: true } } },
    });
    if (!teacher) throw new NotFoundException(msg('teachers.notFound'));

    if (dto.courseId) {
      const course = await this.prisma.course.findFirst({ where: { id: dto.courseId, tenantId, teacherId } });
      if (!course) throw new NotFoundException(msg('sessions.courseNotFound'));
    }

    // Resolve attendees: explicit list, else everyone enrolled in the course.
    let studentIds = dto.studentIds ?? [];
    if (studentIds.length === 0 && dto.courseId) {
      const enrollments = await this.prisma.enrollment.findMany({
        where: { courseId: dto.courseId, status: 'ACTIVE' },
        select: { studentId: true },
      });
      studentIds = enrollments.map((e) => e.studentId);
    }
    const students = await this.prisma.student.findMany({
      where: { id: { in: studentIds }, tenantId },
      select: { id: true, user: { select: { email: true } } },
    });
    if (students.length !== studentIds.length) throw new NotFoundException(msg('sessions.studentNotFound'));
    const people = { teacherId, studentIds: students.map((s) => s.id) };
    // Checked before the meeting is made, and again under a lock when saving (another booking may land in between).
    await assertFree(this.prisma, tenantId, people, { startAt, endAt });

    // Create the meeting on the teacher's own account (or keep the pasted link).
    const meeting =
      dto.provider === 'MANUAL'
        ? { joinUrl: dto.meetingUrl, externalMeetingId: undefined }
        : await this.providerFor(dto.provider).createMeeting({
            hostUserId: teacher.user.id,
            title: dto.title,
            description: dto.description,
            startAt,
            endAt,
            timezone: teacher.tenant.timezone,
            attendeeEmails: students.map((s) => s.user.email),
          });

    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockPeople(tx, people);
        await assertFree(tx, tenantId, people, { startAt, endAt });
        return tx.session.create({
          data: {
            tenantId,
            teacherId,
            courseId: dto.courseId,
            title: dto.title,
            description: dto.description,
            provider: dto.provider,
            startAt,
            endAt,
            meetingUrl: meeting.joinUrl,
            externalMeetingId: meeting.externalMeetingId,
            attendees: { create: students.map((s) => ({ studentId: s.id })) },
          },
          include: sessionInclude,
        });
      });
    } catch (err) {
      // Don't leave an orphan meeting on the teacher's account.
      if (meeting.externalMeetingId && dto.provider !== 'MANUAL') {
        await this.deleteExternal(dto.provider, teacher.user.id, meeting.externalMeetingId);
      }
      throw err;
    }
  }

  async update(user: JwtUser, id: string, dto: UpdateSessionDto) {
    const session = await this.getOwned(user, id);
    const startAt = dto.startAt ? new Date(dto.startAt) : session.startAt;
    const endAt = dto.endAt ? new Date(dto.endAt) : session.endAt;
    // Forms send whole minutes, so an unchanged time may come back without its seconds.
    const retimed = !sameMinute(startAt, session.startAt) || !sameMinute(endAt, session.endAt);

    if (retimed && !canReschedule(session.status)) throw new BadRequestException(msg('sessions.notReschedulable'));
    if (endAt <= startAt) throw new BadRequestException(msg('sessions.endBeforeStart'));
    if (dto.meetingUrl !== undefined && dto.meetingUrl !== session.meetingUrl) {
      if (session.provider !== 'MANUAL') throw new BadRequestException(msg('sessions.urlOnlyManual'));
      if (!canReschedule(session.status)) throw new BadRequestException(msg('sessions.notReschedulable'));
    }

    // The new time must still be free for the teacher and every student in the session.
    const people = retimed
      ? {
          teacherId: session.teacherId,
          studentIds: (
            await this.prisma.sessionAttendee.findMany({ where: { sessionId: id }, select: { studentId: true } })
          ).map((a) => a.studentId),
        }
      : null;
    if (people) await assertFree(this.prisma, session.tenantId, people, { startAt, endAt }, id);

    const renamed =
      (dto.title !== undefined && dto.title !== session.title) ||
      (dto.description !== undefined && dto.description !== session.description);
    // Keep the provider's meeting (and the invitations it sent) in step with the platform.
    if ((retimed || renamed) && isOpen(session.status) && session.externalMeetingId && session.provider !== 'MANUAL') {
      await this.providerFor(session.provider).updateMeeting(session.teacher.userId, session.externalMeetingId, {
        title: dto.title ?? session.title,
        description: dto.description ?? session.description,
        startAt,
        endAt,
        timezone: session.tenant.timezone,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      if (people) {
        await lockPeople(tx, people);
        await assertFree(tx, session.tenantId, people, { startAt, endAt }, id);
      }
      return tx.session.update({
        where: { id },
        data: { ...dto, startAt: retimed ? startAt : undefined, endAt: retimed ? endAt : undefined },
        include: sessionInclude,
      });
    });
  }

  /**
   * The host opens their meeting: returns the link to open (Zoom's start link is fetched fresh,
   * since it expires) and marks the session live. Only the session's own teacher may do this:
   * a Zoom start link signs in as that teacher.
   */
  async start(user: JwtUser, id: string) {
    const session = await this.getOwned(user, id);
    if (!user.teacherId || session.teacherId !== user.teacherId) {
      throw new ForbiddenException(msg('sessions.onlyHostCanStart'));
    }
    if (!nextStatus(session.status, 'start')) throw new BadRequestException(msg('sessions.cannotStart'));
    if (entryWindow(session, new Date()) === 'early') {
      throw new BadRequestException(msg('sessions.tooEarly', { minutes: EARLY_ENTRY_MIN }));
    }

    const hostUrl =
      session.externalMeetingId && session.provider !== 'MANUAL'
        ? await this.providerFor(session.provider).hostUrl(session.teacher.userId, session.externalMeetingId)
        : null;
    const url = hostUrl ?? session.meetingUrl;
    if (!url) throw new BadRequestException(msg('sessions.noMeetingLink'));

    if (session.status === 'SCHEDULED') {
      await this.prisma.session.update({
        where: { id },
        data: { status: 'LIVE', startedAt: session.startedAt ?? new Date() },
      });
    }
    return { url };
  }

  async complete(user: JwtUser, id: string) {
    const session = await this.getOwned(user, id);
    if (!nextStatus(session.status, 'complete')) throw new BadRequestException(msg('sessions.cannotComplete'));
    // A live session can always end (it may have started early); an unstarted one only once its time came.
    if (session.status !== 'LIVE' && session.startAt > new Date()) {
      throw new BadRequestException(msg('sessions.notStartedYet'));
    }
    return this.prisma.session.update({
      where: { id },
      data: { status: 'COMPLETED', endedAt: session.status === 'LIVE' ? new Date() : session.endedAt },
      include: sessionInclude,
    });
  }

  async cancel(user: JwtUser, id: string) {
    const session = await this.getOwned(user, id);
    if (!nextStatus(session.status, 'cancel')) throw new BadRequestException(msg('sessions.cannotCancel'));
    if (session.externalMeetingId && session.provider !== 'MANUAL') {
      await this.deleteExternal(session.provider, session.teacher.userId, session.externalMeetingId);
    }
    return this.prisma.session.update({ where: { id }, data: { status: 'CANCELED' }, include: sessionInclude });
  }

  /**
   * Only a session that hasn't started can be deleted (one made by mistake). Anything that started,
   * ended, was missed or was canceled is the record behind attendance, evaluations, billing and
   * reports, so it stays; an upcoming session the students know about is better canceled.
   */
  async remove(user: JwtUser, id: string) {
    const session = await this.getOwned(user, id);
    if (!canDelete(session)) throw new BadRequestException(msg('sessions.cannotDelete'));
    if (isOpen(session.status) && session.externalMeetingId && session.provider !== 'MANUAL') {
      await this.deleteExternal(session.provider, session.teacher.userId, session.externalMeetingId);
    }
    await this.prisma.session.delete({ where: { id } });
  }

  /**
   * Hands out the join link. Students only get it here (never in lists), so a click counts as
   * attendance; teachers can still correct it, and Zoom's participant events confirm it.
   */
  async join(user: JwtUser, id: string) {
    const session = await this.prisma.session.findFirst({
      where: { id, tenantId: user.tenantId! },
      select: { teacherId: true, status: true, startAt: true, meetingUrl: true },
    });
    if (!session) throw new NotFoundException(msg('sessions.notFound'));
    if (user.role === 'TEACHER' && session.teacherId !== user.teacherId) throw new ForbiddenException();
    const attendee =
      user.role === 'STUDENT'
        ? await this.prisma.sessionAttendee.findUnique({
            where: { sessionId_studentId: { sessionId: id, studentId: user.studentId! } },
          })
        : null;
    if (user.role === 'STUDENT' && !attendee) throw new ForbiddenException();

    const window = entryWindow(session, new Date());
    if (window === 'closed') throw new BadRequestException(msg('sessions.notJoinable'));
    if (window === 'early') throw new BadRequestException(msg('sessions.joinTooEarly', { minutes: EARLY_ENTRY_MIN }));
    if (!session.meetingUrl) throw new BadRequestException(msg('sessions.noMeetingLink'));

    if (attendee && !attendee.attended) {
      await this.prisma.sessionAttendee.update({
        where: { sessionId_studentId: { sessionId: id, studentId: attendee.studentId } },
        data: { attended: true, joinedAt: attendee.joinedAt ?? new Date() },
      });
    }
    return { url: session.meetingUrl };
  }

  async markAttendance(user: JwtUser, id: string, studentId: string, attended: boolean) {
    this.assertHost(user, await this.getOwned(user, id));
    const row = await this.prisma.sessionAttendee.findUnique({
      where: { sessionId_studentId: { sessionId: id, studentId } },
    });
    if (!row) throw new NotFoundException(msg('sessions.studentNotInSession'));
    return this.prisma.sessionAttendee.update({
      where: { sessionId_studentId: { sessionId: id, studentId } },
      data: { attended, joinedAt: attended ? (row.joinedAt ?? new Date()) : null },
    });
  }

  /**
   * The teacher's evaluation after the session: attendance status, a rating out of 10, homework,
   * where the lesson stopped and a note, per student. Saving it again overwrites it. Only the
   * session's own teacher evaluates; admins read it through `get`.
   */
  async evaluate(user: JwtUser, id: string, dto: EvaluateSessionDto) {
    const session = await this.getOwned(user, id);
    this.assertHost(user, session);
    if (session.status === 'CANCELED') throw new BadRequestException(msg('sessions.evaluateCanceled'));
    if (session.startAt > new Date()) throw new BadRequestException(msg('sessions.evaluateBeforeStart'));
    const ids = dto.evaluations.map((e) => e.studentId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException(msg('sessions.duplicateStudent'));
    const inSession = await this.prisma.sessionAttendee.count({ where: { sessionId: id, studentId: { in: ids } } });
    if (inSession !== ids.length) throw new NotFoundException(msg('sessions.studentNotInSession'));

    const now = new Date();
    await this.prisma.$transaction(
      dto.evaluations.map((e) =>
        this.prisma.sessionAttendee.update({
          where: { sessionId_studentId: { sessionId: id, studentId: e.studentId } },
          data: evaluationRow(e, now),
        }),
      ),
    );
    return this.get(user, id);
  }

  // ───────── Provider events (Zoom webhooks) ─────────

  async providerStarted(provider: SessionProvider, externalMeetingId: string, at: Date) {
    const session = await this.findByMeeting(provider, externalMeetingId);
    if (!session) return;
    // A meeting reported as started after we gave up on it (MISSED) did happen after all.
    if (session.status !== 'SCHEDULED' && session.status !== 'MISSED') return;
    await this.prisma.session.update({
      where: { id: session.id },
      data: { status: 'LIVE', startedAt: session.startedAt ?? at },
    });
  }

  async providerEnded(provider: SessionProvider, externalMeetingId: string, startedAt: Date | null, endedAt: Date) {
    const session = await this.findByMeeting(provider, externalMeetingId);
    if (!session || session.status === 'CANCELED') return;
    await this.prisma.session.update({
      where: { id: session.id },
      data: { status: 'COMPLETED', startedAt: session.startedAt ?? startedAt ?? undefined, endedAt },
    });
  }

  /** Marks a student present when a Zoom participant signs in with the student's email. */
  async providerParticipantJoined(provider: SessionProvider, externalMeetingId: string, email: string, at: Date) {
    const session = await this.findByMeeting(provider, externalMeetingId);
    if (!session) return;
    await this.prisma.sessionAttendee.updateMany({
      where: {
        sessionId: session.id,
        attended: false,
        student: { user: { email: { equals: email, mode: 'insensitive' } } },
      },
      data: { attended: true, joinedAt: at },
    });
  }

  /** Closes sessions whose time has passed without a start or end (runs every few minutes). */
  async closeOverdue(now = new Date()) {
    const { liveEndedBefore, unstartedEndedBefore } = overdueCutoffs(now);
    try {
      await this.prisma.session.updateMany({
        where: { status: 'LIVE', endAt: { lt: liveEndedBefore } },
        data: { status: 'COMPLETED' },
      });
      for (const provider of PROVIDERS) {
        await this.prisma.session.updateMany({
          where: { status: 'SCHEDULED', provider, endAt: { lt: unstartedEndedBefore } },
          data: { status: unstartedOutcome(provider, this.zoomEventsEnabled) },
        });
      }
    } catch (err) {
      this.logger.warn(`Closing overdue sessions failed: ${String(err)}`);
    }
  }

  // ───────── helpers ─────────

  /**
   * Students never get the link from lists: they go through `join`, which records attendance.
   * A suspended member gets no link at all: `start` and `join` are refused for them, and the raw
   * link would let them into the meeting anyway.
   */
  private forViewer<T extends { meetingUrl: string | null }>(user: JwtUser, session: T): T {
    return user.role === 'STUDENT' || user.status === 'SUSPENDED' ? { ...session, meetingUrl: null } : session;
  }

  private findByMeeting(provider: SessionProvider, externalMeetingId: string) {
    return this.prisma.session.findFirst({
      where: { provider, externalMeetingId },
      select: { id: true, status: true, startedAt: true },
    });
  }

  /** Attendance and evaluations are the session teacher's call, even for admins (who can still read them). */
  private assertHost(user: JwtUser, session: { teacherId: string }) {
    if (!user.teacherId || session.teacherId !== user.teacherId) {
      throw new ForbiddenException(msg('sessions.onlyTeacherEvaluates'));
    }
  }

  private async getOwned(user: JwtUser, id: string) {
    const session = await this.prisma.session.findFirst({
      where: { id, tenantId: user.tenantId! },
      include: { teacher: { select: { userId: true } }, tenant: { select: { timezone: true } } },
    });
    if (!session) throw new NotFoundException(msg('sessions.notFound'));
    if (user.role === 'TEACHER' && session.teacherId !== user.teacherId) throw new ForbiddenException();
    return session;
  }

  /** Best effort: the session changes locally even if the provider can't be reached. */
  async deleteExternal(provider: 'ZOOM' | 'GOOGLE_MEET', hostUserId: string, externalMeetingId: string) {
    try {
      await this.providerFor(provider).deleteMeeting(hostUserId, externalMeetingId);
    } catch (err) {
      this.logger.warn(`Failed to delete ${provider} meeting ${externalMeetingId}: ${String(err)}`);
    }
  }

  providerFor(provider: 'ZOOM' | 'GOOGLE_MEET'): MeetingProvider {
    return provider === 'ZOOM' ? this.zoom : this.google;
  }
}

const sameMinute = (a: Date, b: Date) => Math.floor(a.getTime() / 60_000) === Math.floor(b.getTime() / 60_000);
