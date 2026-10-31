import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { msg } from '../i18n/i18n.js';
import { ZoomProvider } from './providers/zoom.provider.js';
import { SessionsService, meetingFacts } from './sessions.service.js';
import { EARLY_ENTRY_MIN, RECONNECT_GRACE_MIN } from './session-lifecycle.js';
import { type CallPair, answers, callPair, callWindowOpen, hangUpStatus, isOpenCall, presentCall, sessionForCall } from './call-rules.js';

const MIN = 60_000;

const callRow = {
  id: true,
  sessionId: true,
  conversationId: true,
  callerId: true,
  status: true,
  joinUrl: true,
  externalMeetingId: true,
  answeredAt: true,
  endedAt: true,
  createdAt: true,
} as const;

const callSession = {
  ...meetingFacts,
  title: true,
  startAt: true,
  provider: true,
  meetingUrl: true,
  teacher: { select: { userId: true } },
  tenant: { select: { timezone: true } },
} as const;

type CallRow = Awaited<ReturnType<CallsService['findCall']>>;
type CallSession = NonNullable<Awaited<ReturnType<CallsService['currentSession']>>>;

/**
 * Calls between a teacher and their student from their direct chat, during one of their
 * one-to-one sessions (rules in call-rules.ts). A call is a meeting plus a card in the chat:
 * placing one rings the other side (the card arrives over the chat socket), and when its meeting
 * drops, either side calls again. The session stays live in between (session-lifecycle.ts), so
 * attendance and billing see one class.
 *
 * The teacher is always the host: a Zoom call is a fresh meeting on the teacher's account (the
 * teacher gets its start link), a Meet or pasted-link session reuses the session's link.
 */
@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    private readonly sessions: SessionsService,
    private readonly zoom: ZoomProvider,
  ) {}

  /** For the chat header: the session a call would join now (null: no calling), and the call to rejoin. */
  async state(user: JwtUser, conversationId: string) {
    const pair = await this.pair(user, conversationId);
    const session = await this.currentSession(user.tenantId!, pair);
    const open = session ? await this.openCall(session.id) : null;
    return {
      session: session && { id: session.id, title: session.title, startAt: session.startAt, endAt: session.endAt, status: session.status },
      call: open && presentCall(open),
      earlyMinutes: EARLY_ENTRY_MIN,
      graceMinutes: RECONNECT_GRACE_MIN,
    };
  }

  /** Rings the other side and hands the caller their link. A call already ringing or on is joined instead. */
  async place(user: JwtUser, conversationId: string) {
    const pair = await this.pair(user, conversationId);
    const session = await this.currentSession(user.tenantId!, pair);
    if (!session) throw new BadRequestException(msg('calls.noSession', { minutes: EARLY_ENTRY_MIN }));

    const open = await this.openCall(session.id);
    if (open) return this.joinOpen(user, open, pair, session);

    const meeting = await this.meetingFor(session);
    let placed = true;
    let call: CallRow;
    try {
      call = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`session-call:${session.id}`}))`;
        // Both pressed "call" at once: the first call wins and the other joins it.
        const raced = await tx.sessionCall.findFirst({ where: { sessionId: session.id }, orderBy: { createdAt: 'desc' }, select: callRow });
        if (raced && isOpenCall(raced)) {
          placed = false;
          return raced;
        }
        const created = await tx.sessionCall.create({
          data: {
            tenantId: user.tenantId!,
            sessionId: session.id,
            conversationId,
            callerId: user.membershipId!,
            joinUrl: meeting.joinUrl,
            externalMeetingId: meeting.externalMeetingId,
          },
          select: callRow,
        });
        await this.messaging.callMessage(tx, conversationId, user.tenantId!, user.membershipId!, created.id);
        return created;
      });
    } catch (err) {
      await this.dropMeeting(session, meeting.externalMeetingId);
      throw err;
    }
    if (!placed) {
      await this.dropMeeting(session, meeting.externalMeetingId);
      return this.joinOpen(user, call, pair, session);
    }
    this.push(call.id, true);
    return this.enter(user, call, pair, session);
  }

  /** Answers a ringing call (the other side), or goes back into one (either side). */
  async join(user: JwtUser, callId: string) {
    const { call, pair } = await this.ownCall(user, callId);
    const session = await this.prisma.session.findUniqueOrThrow({ where: { id: call.sessionId }, select: callSession });
    if (!isOpenCall(call) || !callWindowOpen(session, new Date())) throw new BadRequestException(msg('calls.over'));
    return this.joinOpen(user, call, pair, session);
  }

  /** Declines or calls off a ringing call, or hangs up one in progress. Already over: nothing to do. */
  async end(user: JwtUser, callId: string) {
    const { call } = await this.ownCall(user, callId);
    const next = hangUpStatus(call);
    if (!next) return presentCall(call);
    const { count } = await this.prisma.sessionCall.updateMany({
      where: { id: call.id, status: call.status },
      data: { status: next, endedAt: new Date() },
    });
    if (count) {
      this.push(call.id, false);
      // Nobody went in: the meeting made for it isn't needed (one in progress may still have people in it).
      if (next === 'MISSED' && call.externalMeetingId) {
        const session = await this.prisma.session.findUniqueOrThrow({ where: { id: call.sessionId }, select: callSession });
        await this.dropMeeting(session, call.externalMeetingId);
      }
    }
    return presentCall(await this.findCall(call.id));
  }

  /* ── Zoom events for a call's own meeting ── */

  async providerStarted(externalMeetingId: string, at: Date) {
    const call = await this.byMeeting(externalMeetingId);
    if (call) await this.sessions.meetingStarted(call.session, at, null);
  }

  /** The meeting ended (dropped at 40 minutes, or everyone left): the call is over, the session may go on. */
  async providerEnded(externalMeetingId: string, startedAt: Date | null, endedAt: Date) {
    const call = await this.byMeeting(externalMeetingId);
    if (!call) return;
    const next = hangUpStatus(call, endedAt);
    if (next) {
      await this.prisma.sessionCall.updateMany({ where: { id: call.id, status: call.status }, data: { status: next, endedAt } });
      this.push(call.id, false);
    }
    await this.sessions.meetingEnded(call.session, startedAt, endedAt);
    await this.sessions.deleteExternal('ZOOM', call.session.teacher.userId, externalMeetingId);
  }

  /** Marks the student present when they sign in to the call's Zoom meeting with their email. */
  async providerParticipantJoined(externalMeetingId: string, email: string, at: Date) {
    const call = await this.byMeeting(externalMeetingId);
    if (!call) return;
    await this.prisma.sessionAttendee.updateMany({
      where: { sessionId: call.sessionId, attended: false, student: { user: { email: { equals: email, mode: 'insensitive' } } } },
      data: { attended: true, joinedAt: at },
    });
  }

  /* ── Helpers ── */

  /** The teacher and the student of the caller's direct chat (calls are only between the two). */
  private async pair(user: JwtUser, conversationId: string) {
    const { self, other } = await this.messaging.directPair(user, conversationId);
    const pair = callPair(self, other);
    if (!pair) throw new BadRequestException(msg('calls.notTeacherStudent'));
    return pair;
  }

  /** The pair's one-to-one session that is on now, if any. */
  async currentSession(tenantId: string, pair: CallPair, now = new Date()) {
    const sessions = await this.prisma.session.findMany({
      where: {
        tenantId,
        teacherId: pair.teacherId,
        status: { in: ['SCHEDULED', 'LIVE'] },
        startAt: { lte: new Date(now.getTime() + EARLY_ENTRY_MIN * MIN) },
        endAt: { gte: new Date(now.getTime() - RECONNECT_GRACE_MIN * MIN) },
        // One-to-one: the student is in it, and nobody else is.
        attendees: { some: { studentId: pair.studentId }, every: { studentId: pair.studentId } },
      },
      select: callSession,
    });
    return sessionForCall(sessions, now);
  }

  /** The session's latest call, while it is still ringing or on. */
  private async openCall(sessionId: string) {
    const last = await this.prisma.sessionCall.findFirst({ where: { sessionId }, orderBy: { createdAt: 'desc' }, select: callRow });
    return last && isOpenCall(last) ? last : null;
  }

  /** A call in the caller's own chat. */
  private async ownCall(user: JwtUser, callId: string) {
    const call = await this.prisma.sessionCall.findFirst({ where: { id: callId, tenantId: user.tenantId! }, select: callRow });
    if (!call) throw new NotFoundException(msg('calls.notFound'));
    const pair = await this.pair(user, call.conversationId).catch(() => {
      throw new NotFoundException(msg('calls.notFound'));
    });
    return { call, pair };
  }

  findCall(id: string) {
    return this.prisma.sessionCall.findUniqueOrThrow({ where: { id }, select: callRow });
  }

  private byMeeting(externalMeetingId: string) {
    return this.prisma.sessionCall.findFirst({
      where: { externalMeetingId },
      select: { ...callRow, session: { select: callSession } },
    });
  }

  /** Into a call that is ringing or on: the side that didn't place it picks up. */
  private async joinOpen(user: JwtUser, call: CallRow, pair: CallPair, session: CallSession) {
    if (answers(call, user.membershipId!)) {
      const { count } = await this.prisma.sessionCall.updateMany({
        where: { id: call.id, status: 'RINGING' },
        data: { status: 'ACTIVE', answeredAt: new Date() },
      });
      if (count) this.push(call.id, false);
    }
    return this.enter(user, call, pair, session);
  }

  /**
   * The link to open: the teacher hosts (a fresh Zoom start link) and their going in starts the
   * session; the student joins, which counts as attendance.
   */
  private async enter(user: JwtUser, call: CallRow, pair: CallPair, session: CallSession) {
    let url = call.joinUrl;
    if (user.teacherId === pair.teacherId) {
      if (call.externalMeetingId) url = (await this.zoom.hostUrl(session.teacher.userId, call.externalMeetingId)) ?? url;
      await this.sessions.meetingStarted(session, new Date(), user.id);
    } else {
      const where = { sessionId_studentId: { sessionId: session.id, studentId: pair.studentId } };
      const attendee = await this.prisma.sessionAttendee.findUnique({ where });
      if (attendee && !attendee.attended) {
        await this.prisma.sessionAttendee.update({ where, data: { attended: true, joinedAt: attendee.joinedAt ?? new Date() } });
      }
    }
    return { url, call: presentCall(await this.findCall(call.id)) };
  }

  /** Zoom: a meeting of its own on the teacher's account. Meet and pasted links: the session's link. */
  private async meetingFor(session: CallSession) {
    if (session.provider !== 'ZOOM') {
      if (!session.meetingUrl) throw new BadRequestException(msg('sessions.noMeetingLink'));
      return { joinUrl: session.meetingUrl, externalMeetingId: null };
    }
    const now = new Date();
    const meeting = await this.zoom.createMeeting({
      hostUserId: session.teacher.userId,
      title: session.title,
      startAt: now,
      endAt: new Date(Math.max(session.endAt.getTime(), now.getTime() + RECONNECT_GRACE_MIN * MIN)),
      timezone: session.tenant.timezone,
      attendeeEmails: [],
    });
    return { joinUrl: meeting.joinUrl, externalMeetingId: meeting.externalMeetingId };
  }

  private async dropMeeting(session: CallSession, externalMeetingId: string | null) {
    if (externalMeetingId) await this.sessions.deleteExternal('ZOOM', session.teacher.userId, externalMeetingId);
  }

  /** After the commit, as a hint: the chat refetches on reconnect. */
  private push(callId: string, placed: boolean) {
    this.messaging.pushCall(callId, placed).catch((err: unknown) => this.logger.warn(`Pushing call ${callId} failed: ${String(err)}`));
  }
}
