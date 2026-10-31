import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { RealtimeEvent } from '../realtime/rooms.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import { Prisma } from '../generated/prisma/client.js';
import { msg } from '../i18n/i18n.js';
import { callSelect, presentCall } from '../sessions/call-rules.js';
import {
  type ChatMember,
  MAX_GROUP_MEMBERS,
  canCreateGroup,
  canDelete,
  canEdit,
  canMessage,
  canPost,
  cleanBody,
  directKey,
} from './messaging-rules.js';
import type {
  ContactsQueryDto,
  ConversationSettingsDto,
  CreateGroupDto,
  MessagesQueryDto,
  SendMessageDto,
  UpdateGroupDto,
} from './dto/messaging.dto.js';

const PAGE = 40;
const PREVIEW = 160;
const CONTACTS = 50;

const memberSelect = {
  id: true,
  role: true,
  status: true,
  lastSeenAt: true,
  user: { select: { fullName: true } },
  teacher: { select: { id: true } },
  student: { select: { id: true } },
} as const;

const messageSelect = {
  id: true,
  conversationId: true,
  kind: true,
  body: true,
  params: true,
  senderId: true,
  clientId: true,
  editedAt: true,
  deletedAt: true,
  createdAt: true,
  sender: { select: { role: true, user: { select: { fullName: true } } } },
  replyTo: { select: { id: true, body: true, deletedAt: true, sender: { select: { user: { select: { fullName: true } } } } } },
  call: { select: callSelect },
} as const;

type MessageRow = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;
type MemberRow = Prisma.MembershipGetPayload<{ select: typeof memberSelect }>;

/**
 * Messaging inside a center: direct chats between two members and groups (free groups, or a
 * course's class group kept in step with its enrollments). Who may reach whom is decided by
 * messaging-rules.ts. Every query is scoped by the tenant and by the caller being a participant.
 *
 * Each write commits first and is then pushed to the participants' chat sockets; unread counters
 * move in the same transaction as the message, so badges never drift from the messages.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /* ── Inbox ── */

  async inbox(user: JwtUser, archived = false) {
    const rows = await this.prisma.conversationParticipant.findMany({
      where: { membershipId: me(user), archivedAt: archived ? { not: null } : null, conversation: { tenantId: user.tenantId! } },
      orderBy: { conversation: { lastMessageAt: 'desc' } },
      take: 200,
      select: { conversationId: true },
    });
    return this.summaries(user, rows.map((r) => r.conversationId));
  }

  /** Totals for the navigation badge. */
  async unread(user: JwtUser) {
    const agg = await this.prisma.conversationParticipant.aggregate({
      where: { membershipId: me(user), unreadCount: { gt: 0 }, conversation: { tenantId: user.tenantId! } },
      _sum: { unreadCount: true },
      _count: true,
    });
    return { messages: agg._sum.unreadCount ?? 0, conversations: agg._count };
  }

  /** Members the caller may start a direct chat with (or put in a group), filtered by name. */
  async contacts(user: JwtUser, q: ContactsQueryDto) {
    const self = await this.member(user.tenantId!, me(user));
    const search = q.q?.trim();
    const rows = await this.prisma.membership.findMany({
      where: {
        tenantId: user.tenantId!,
        id: { not: self.membershipId },
        status: { not: 'BLOCKED' },
        // A student reaches the admins and their own teachers; a teacher, all but others' students.
        ...(self.role === 'STUDENT' && { OR: [{ role: 'TENANT_ADMIN' }, { teacher: { students: { some: { studentId: self.studentId! } } } }] }),
        ...(self.role === 'TEACHER' && { OR: [{ role: { not: 'STUDENT' } }, { student: { teachers: { some: { teacherId: self.teacherId! } } } }] }),
        ...(search && { user: { fullName: { contains: search, mode: 'insensitive' } } }),
      },
      orderBy: [{ role: 'asc' }, { user: { fullName: 'asc' } }],
      take: CONTACTS * 2,
      select: memberSelect,
    });
    const teaches = await this.teachesFor([self, ...rows.map(toChatMember)]);
    return rows
      .map((r) => ({ row: r, member: toChatMember(r) }))
      .filter(({ member }) => canMessage(self, member, teaches))
      .slice(0, CONTACTS)
      .map(({ row }) => ({ membershipId: row.id, fullName: row.user.fullName, role: row.role, online: this.realtime.presence.isOnline(row.id) }));
  }

  /* ── Conversations ── */

  /** The direct chat with one member, created on first use. */
  async startDirect(user: JwtUser, membershipId: string) {
    const self = await this.member(user.tenantId!, me(user));
    const other = await this.member(user.tenantId!, membershipId).catch(() => null);
    if (!other) throw new NotFoundException(msg('messages.memberNotFound'));
    if (!canMessage(self, other, await this.teachesFor([self, other]))) throw new ForbiddenException(msg('messages.cannotMessage'));

    const key = directKey(self.membershipId, other.membershipId);
    let conversation = await this.prisma.conversation.findUnique({ where: { directKey: key }, select: { id: true } });
    if (!conversation) {
      try {
        conversation = await this.prisma.conversation.create({
          data: {
            tenantId: user.tenantId!,
            kind: 'DIRECT',
            directKey: key,
            createdById: self.membershipId,
            participants: { create: [{ membershipId: self.membershipId }, { membershipId: other.membershipId }] },
          },
          select: { id: true },
        });
      } catch (err) {
        // Both started it at the same moment: use the one that won.
        if (!isUniqueViolation(err)) throw err;
        conversation = await this.prisma.conversation.findUniqueOrThrow({ where: { directKey: key }, select: { id: true } });
      }
    }
    // Opening it again brings it back from the archive.
    await this.prisma.conversationParticipant.updateMany({
      where: { conversationId: conversation.id, membershipId: self.membershipId, archivedAt: { not: null } },
      data: { archivedAt: null },
    });
    return this.summary(user, conversation.id);
  }

  async createGroup(user: JwtUser, dto: CreateGroupDto) {
    if (!canCreateGroup(user.role)) throw new ForbiddenException(msg('messages.cannotCreateGroup'));
    const self = await this.member(user.tenantId!, me(user));
    let title = dto.title?.trim();
    let memberIds: string[];

    if (dto.courseId) {
      const course = await this.prisma.course.findFirst({
        where: { id: dto.courseId, tenantId: user.tenantId! },
        select: {
          id: true,
          title: true,
          teacherId: true,
          teacher: { select: { membershipId: true } },
          enrollments: { where: { status: 'ACTIVE' }, select: { student: { select: { membershipId: true } } } },
        },
      });
      if (!course) throw new NotFoundException(msg('courses.notFound'));
      if (user.role === 'TEACHER' && course.teacherId !== user.teacherId) throw new ForbiddenException(msg('messages.notYourCourse'));
      // One class group per course: asking again opens it.
      const existing = await this.prisma.conversation.findFirst({ where: { courseId: course.id, tenantId: user.tenantId! }, select: { id: true } });
      if (existing) {
        await this.addParticipants(existing.id, [self.membershipId], false);
        return this.summary(user, existing.id);
      }
      title ||= course.title;
      memberIds = [course.teacher.membershipId, ...course.enrollments.map((e) => e.student.membershipId)];
    } else {
      if (!title) throw new BadRequestException(msg('messages.titleRequired'));
      memberIds = await this.reachable(user.tenantId!, self, dto.membershipIds ?? []);
    }

    const ids = [...new Set([self.membershipId, ...memberIds])];
    if (ids.length > MAX_GROUP_MEMBERS) throw new BadRequestException(msg('messages.tooManyMembers', { max: MAX_GROUP_MEMBERS }));

    const conversation = await this.prisma.$transaction(async (tx) => {
      const c = await tx.conversation.create({
        data: {
          tenantId: user.tenantId!,
          kind: 'GROUP',
          title: title!,
          courseId: dto.courseId ?? null,
          adminsOnly: dto.adminsOnly ?? false,
          createdById: self.membershipId,
          participants: {
            create: ids.map((id) => ({ membershipId: id, isAdmin: id === self.membershipId, lastReadAt: id === self.membershipId ? new Date() : null })),
          },
        },
        select: { id: true },
      });
      await this.systemMessage(tx, c.id, user.tenantId!, self.membershipId, { event: 'created', title: title! }, { countUnread: true });
      return c;
    });
    this.realtime.toChat(ids, RealtimeEvent.conversationUpdated, { conversationId: conversation.id });
    return this.summary(user, conversation.id);
  }

  /** The conversation with its members, admins first. */
  async detail(user: JwtUser, id: string) {
    await this.participantOf(user, id);
    const [summary, members] = await Promise.all([
      this.summary(user, id),
      this.prisma.conversationParticipant.findMany({
        where: { conversationId: id },
        select: { membershipId: true, isAdmin: true, lastReadAt: true, membership: { select: { role: true, lastSeenAt: true, user: { select: { fullName: true } } } } },
      }),
    ]);
    const participants = members
      .map((p) => ({
        membershipId: p.membershipId,
        fullName: p.membership.user.fullName,
        role: p.membership.role,
        isAdmin: p.isAdmin,
        lastReadAt: p.lastReadAt,
        lastSeenAt: p.membership.lastSeenAt,
        online: this.realtime.presence.isOnline(p.membershipId),
      }))
      .sort((a, b) => Number(b.isAdmin) - Number(a.isAdmin) || a.fullName.localeCompare(b.fullName));
    return { ...summary, participants };
  }

  async updateGroup(user: JwtUser, id: string, dto: UpdateGroupDto) {
    const { conversation } = await this.groupAdmin(user, id);
    const title = dto.title?.trim();
    const renamed = title && title !== conversation.title;
    await this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({ where: { id }, data: { ...(renamed && { title }), ...(dto.adminsOnly !== undefined && { adminsOnly: dto.adminsOnly }) } });
      if (renamed) await this.systemMessage(tx, id, user.tenantId!, me(user), { event: 'renamed', title });
      if (dto.adminsOnly !== undefined && dto.adminsOnly !== conversation.adminsOnly) {
        await this.systemMessage(tx, id, user.tenantId!, me(user), { event: dto.adminsOnly ? 'adminsOnly' : 'everyonePosts' });
      }
    });
    await this.pushUpdated(id);
    return this.detail(user, id);
  }

  async addMembers(user: JwtUser, id: string, membershipIds: string[]) {
    await this.groupAdmin(user, id);
    const self = await this.member(user.tenantId!, me(user));
    const ids = await this.reachable(user.tenantId!, self, membershipIds);
    const count = await this.prisma.conversationParticipant.count({ where: { conversationId: id } });
    if (count + ids.length > MAX_GROUP_MEMBERS) throw new BadRequestException(msg('messages.tooManyMembers', { max: MAX_GROUP_MEMBERS }));
    const added = await this.addParticipants(id, ids, true, self.membershipId);
    if (added.length) await this.pushUpdated(id);
    return this.detail(user, id);
  }

  /** A group admin removes a member, or anyone leaves (`membershipId` = themselves). */
  async removeMember(user: JwtUser, id: string, membershipId: string) {
    const leaving = membershipId === me(user);
    const { conversation } = leaving ? await this.participantOf(user, id) : await this.groupAdmin(user, id);
    if (conversation.kind !== 'GROUP') throw new BadRequestException(msg('messages.notAGroup'));
    const target = await this.prisma.conversationParticipant.findUnique({
      where: { conversationId_membershipId: { conversationId: id, membershipId } },
      select: { membership: { select: { user: { select: { fullName: true } } } } },
    });
    if (!target) throw new NotFoundException(msg('messages.memberNotFound'));

    const others = await this.prisma.$transaction(async (tx) => {
      await tx.conversationParticipant.delete({ where: { conversationId_membershipId: { conversationId: id, membershipId } } });
      const rest = await tx.conversationParticipant.findMany({ where: { conversationId: id }, orderBy: { joinedAt: 'asc' }, select: { membershipId: true, isAdmin: true } });
      // A group is never left without an admin: the longest-standing member takes over.
      if (rest.length && !rest.some((p) => p.isAdmin)) {
        await tx.conversationParticipant.update({ where: { conversationId_membershipId: { conversationId: id, membershipId: rest[0].membershipId } }, data: { isAdmin: true } });
      }
      await this.systemMessage(tx, id, user.tenantId!, me(user), leaving ? { event: 'left' } : { event: 'removed', member: target.membership.user.fullName });
      return rest.map((p) => p.membershipId);
    });
    this.realtime.toChat([membershipId], RealtimeEvent.conversationRemoved, { conversationId: id });
    this.realtime.toChat(others, RealtimeEvent.conversationUpdated, { conversationId: id });
    return { ok: true };
  }

  /** Makes a member a group admin, or not (never the last admin). */
  async setMemberRole(user: JwtUser, id: string, membershipId: string, isAdmin: boolean) {
    await this.groupAdmin(user, id);
    const admins = await this.prisma.conversationParticipant.count({ where: { conversationId: id, isAdmin: true } });
    const target = await this.prisma.conversationParticipant.findUnique({ where: { conversationId_membershipId: { conversationId: id, membershipId } } });
    if (!target) throw new NotFoundException(msg('messages.memberNotFound'));
    if (!isAdmin && target.isAdmin && admins <= 1) throw new BadRequestException(msg('messages.lastAdmin'));
    await this.prisma.conversationParticipant.update({ where: { conversationId_membershipId: { conversationId: id, membershipId } }, data: { isAdmin } });
    await this.pushUpdated(id);
    return this.detail(user, id);
  }

  /** Personal: mute alerts, or archive (until the next message). */
  async settings(user: JwtUser, id: string, dto: ConversationSettingsDto) {
    await this.participantOf(user, id);
    await this.prisma.conversationParticipant.update({
      where: { conversationId_membershipId: { conversationId: id, membershipId: me(user) } },
      data: { ...(dto.muted !== undefined && { muted: dto.muted }), ...(dto.archived !== undefined && { archivedAt: dto.archived ? new Date() : null }) },
    });
    this.realtime.toChat([me(user)], RealtimeEvent.conversationUpdated, { conversationId: id });
    return this.summary(user, id);
  }

  /** Everything up to now is read: clears the badge, and the others see the receipt. */
  async markRead(user: JwtUser, id: string) {
    const { participant, conversation } = await this.participantOf(user, id);
    const lastReadAt = new Date();
    if (participant.unreadCount > 0 || !participant.lastReadAt || participant.lastReadAt < conversation.lastMessageAt) {
      await this.prisma.conversationParticipant.update({
        where: { conversationId_membershipId: { conversationId: id, membershipId: me(user) } },
        data: { unreadCount: 0, lastReadAt },
      });
      const everyone = await this.participantIds(id);
      this.realtime.toChat(everyone, RealtimeEvent.conversationRead, { conversationId: id, membershipId: me(user), lastReadAt });
    }
    return { ok: true, lastReadAt };
  }

  /* ── Messages ── */

  /** A page of messages, oldest first; `before` pages back in time. */
  async messages(user: JwtUser, id: string, q: MessagesQueryDto) {
    await this.participantOf(user, id);
    const take = q.take ?? PAGE;
    const rows = await this.prisma.message.findMany({
      where: { conversationId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(q.before && { cursor: { id: q.before }, skip: 1 }),
      select: messageSelect,
    });
    return { items: rows.slice(0, take).reverse().map(presentMessage), hasMore: rows.length > take };
  }

  async send(user: JwtUser, id: string, dto: SendMessageDto) {
    const { conversation, participant } = await this.participantOf(user, id);
    if (!canPost(conversation, participant)) throw new ForbiddenException(msg('messages.adminsOnly'));
    const body = cleanBody(dto.body);
    if (!body) throw new BadRequestException(msg('messages.empty'));

    const others = (await this.participantIds(id)).filter((m) => m !== me(user));
    if (conversation.kind === 'DIRECT') await this.assertCanStillMessage(user, others[0]);
    if (dto.replyToId) {
      const original = await this.prisma.message.findFirst({ where: { id: dto.replyToId, conversationId: id }, select: { id: true } });
      if (!original) throw new NotFoundException(msg('messages.notFound'));
    }

    // Sent before (a retry): hand back the stored message, push nothing new.
    const existing = await this.byClientId(me(user), dto.clientId);
    if (existing) return existing;

    let message: MessageRow;
    try {
      message = await this.prisma.$transaction(async (tx) => {
        const m = await tx.message.create({
          data: { conversationId: id, tenantId: user.tenantId!, senderId: me(user), body, replyToId: dto.replyToId ?? null, clientId: dto.clientId },
          select: messageSelect,
        });
        await this.afterMessage(tx, id, me(user), m.createdAt);
        return m;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return (await this.byClientId(me(user), dto.clientId))!;
    }

    const presented = presentMessage(message);
    this.realtime.toChat([me(user), ...others], RealtimeEvent.messageNew, { conversationId: id, message: presented });
    return presented;
  }

  async edit(user: JwtUser, messageId: string, text: string) {
    const { message } = await this.ownMessage(user, messageId);
    if (message.senderId !== me(user)) throw new ForbiddenException(msg('auth.forbidden'));
    if (!canEdit(message, me(user))) throw new ForbiddenException(msg('messages.cannotEdit'));
    const body = cleanBody(text);
    if (!body) throw new BadRequestException(msg('messages.empty'));
    const updated = await this.prisma.message.update({ where: { id: messageId }, data: { body, editedAt: new Date() }, select: messageSelect });
    return this.pushMessage(updated);
  }

  /** Deleted for everyone: the text goes, a placeholder stays, and unread badges drop it. */
  async remove(user: JwtUser, messageId: string) {
    const { message, conversation, participant } = await this.ownMessage(user, messageId);
    if (!canDelete(message, me(user), conversation, participant)) throw new ForbiddenException(msg('messages.cannotDelete'));
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.conversationParticipant.updateMany({
        where: {
          conversationId: message.conversationId,
          membershipId: { not: message.senderId ?? undefined },
          unreadCount: { gt: 0 },
          OR: [{ lastReadAt: null }, { lastReadAt: { lt: message.createdAt } }],
        },
        data: { unreadCount: { decrement: 1 } },
      });
      return tx.message.update({ where: { id: messageId }, data: { body: '', deletedAt: new Date() }, select: messageSelect });
    });
    return this.pushMessage(updated);
  }

  /* ── Calls (CallsService places them; the chat shows them) ── */

  /** Both sides of the caller's direct chat, while they may still talk: calls follow the message rules. */
  async directPair(user: JwtUser, conversationId: string) {
    const { conversation } = await this.participantOf(user, conversationId);
    if (conversation.kind !== 'DIRECT') throw new BadRequestException(msg('calls.notTeacherStudent'));
    const others = (await this.participantIds(conversationId)).filter((m) => m !== me(user));
    return this.assertCanStillMessage(user, others[0]);
  }

  /** A call's card, written with the call: it sorts the inbox and badges like a message. */
  async callMessage(tx: Prisma.TransactionClient, conversationId: string, tenantId: string, callerId: string, callId: string) {
    const m = await tx.message.create({
      data: { conversationId, tenantId, senderId: callerId, kind: 'CALL', body: '', callId },
      select: { createdAt: true },
    });
    await this.afterMessage(tx, conversationId, callerId, m.createdAt);
  }

  /** Pushes a call's card to both sides: new (it rings), or changed (answered, over). */
  async pushCall(callId: string, placed: boolean) {
    const row = await this.prisma.message.findUnique({ where: { callId }, select: messageSelect });
    if (!row) return;
    if (!placed) {
      await this.pushMessage(row);
      return;
    }
    const message = presentMessage(row);
    this.realtime.toChat(await this.participantIds(row.conversationId), RealtimeEvent.messageNew, { conversationId: row.conversationId, message });
  }

  /* ── Course groups follow enrollments (called by CoursesService) ── */

  async courseEnrollmentChanged(courseId: string, studentId: string, enrolled: boolean) {
    try {
      const [groups, student] = await Promise.all([
        this.prisma.conversation.findMany({ where: { courseId, kind: 'GROUP' }, select: { id: true } }),
        this.prisma.student.findUnique({ where: { id: studentId }, select: { membershipId: true } }),
      ]);
      if (!student) return;
      for (const g of groups) {
        if (enrolled) {
          const added = await this.addParticipants(g.id, [student.membershipId], false);
          if (added.length) await this.pushUpdated(g.id);
        } else {
          const { count } = await this.prisma.conversationParticipant.deleteMany({ where: { conversationId: g.id, membershipId: student.membershipId } });
          if (!count) continue;
          this.realtime.toChat([student.membershipId], RealtimeEvent.conversationRemoved, { conversationId: g.id });
          await this.pushUpdated(g.id);
        }
      }
    } catch (err) {
      this.logger.warn(`Syncing course ${courseId} groups failed: ${String(err)}`);
    }
  }

  /* ── Helpers ── */

  /** Inbox rows for these conversations, in the given order, as the caller sees them. */
  private async summaries(user: JwtUser, ids: string[]) {
    if (ids.length === 0) return [];
    const mine = me(user);
    const rows = await this.prisma.conversation.findMany({
      where: { id: { in: ids }, tenantId: user.tenantId! },
      select: {
        id: true,
        kind: true,
        title: true,
        adminsOnly: true,
        lastMessageAt: true,
        course: { select: { id: true, title: true } },
        _count: { select: { participants: true } },
        participants: {
          where: { OR: [{ membershipId: mine }, { conversation: { kind: 'DIRECT' } }] },
          select: {
            membershipId: true,
            isAdmin: true,
            unreadCount: true,
            lastReadAt: true,
            muted: true,
            archivedAt: true,
            membership: { select: { role: true, status: true, lastSeenAt: true, user: { select: { fullName: true } } } },
          },
        },
        messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: messageSelect },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((c) => c !== undefined)
      .map((c) => {
        const self = c.participants.find((p) => p.membershipId === mine);
        const peer = c.kind === 'DIRECT' ? c.participants.find((p) => p.membershipId !== mine) : undefined;
        const last = c.messages[0];
        return {
          id: c.id,
          kind: c.kind,
          title: c.title,
          course: c.course,
          adminsOnly: c.adminsOnly,
          memberCount: c._count.participants,
          lastMessageAt: c.lastMessageAt,
          isAdmin: self?.isAdmin ?? false,
          unreadCount: self?.unreadCount ?? 0,
          lastReadAt: self?.lastReadAt ?? null,
          muted: self?.muted ?? false,
          archived: Boolean(self?.archivedAt),
          peer: peer
            ? {
                membershipId: peer.membershipId,
                fullName: peer.membership.user.fullName,
                role: peer.membership.role,
                blocked: peer.membership.status === 'BLOCKED',
                lastReadAt: peer.lastReadAt,
                lastSeenAt: peer.membership.lastSeenAt,
                online: this.realtime.presence.isOnline(peer.membershipId),
              }
            : null,
          lastMessage: last ? { ...presentMessage(last), body: last.body.slice(0, PREVIEW), replyTo: null } : null,
        };
      });
  }

  private async summary(user: JwtUser, id: string) {
    const [row] = await this.summaries(user, [id]);
    if (!row) throw new NotFoundException(msg('messages.conversationNotFound'));
    return row;
  }

  /** The caller's place in a conversation of their center (or 404: no hint that it exists). */
  private async participantOf(user: JwtUser, conversationId: string) {
    const participant = await this.prisma.conversationParticipant.findUnique({
      where: { conversationId_membershipId: { conversationId, membershipId: me(user) } },
      select: {
        isAdmin: true,
        unreadCount: true,
        lastReadAt: true,
        conversation: { select: { id: true, tenantId: true, kind: true, title: true, adminsOnly: true, lastMessageAt: true } },
      },
    });
    if (!participant || participant.conversation.tenantId !== user.tenantId) throw new NotFoundException(msg('messages.conversationNotFound'));
    return { participant, conversation: participant.conversation };
  }

  private async groupAdmin(user: JwtUser, conversationId: string) {
    const found = await this.participantOf(user, conversationId);
    if (found.conversation.kind !== 'GROUP') throw new BadRequestException(msg('messages.notAGroup'));
    if (!found.participant.isAdmin) throw new ForbiddenException(msg('messages.groupAdminsOnly'));
    return found;
  }

  /** A message in a conversation the caller is in. */
  private async ownMessage(user: JwtUser, messageId: string) {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, tenantId: user.tenantId! },
      select: { id: true, conversationId: true, senderId: true, kind: true, deletedAt: true, createdAt: true },
    });
    if (!message) throw new NotFoundException(msg('messages.notFound'));
    const { participant, conversation } = await this.participantOf(user, message.conversationId).catch(() => {
      throw new NotFoundException(msg('messages.notFound'));
    });
    return { message, participant, conversation };
  }

  private async member(tenantId: string, membershipId: string): Promise<ChatMember> {
    const row = await this.prisma.membership.findFirst({ where: { id: membershipId, tenantId }, select: memberSelect });
    if (!row) throw new NotFoundException(msg('messages.memberNotFound'));
    return toChatMember(row);
  }

  /** Whether the teacher teaches the student, for every teacher/student pair among `members`. */
  private async teachesFor(members: ChatMember[]) {
    const teacherIds = members.map((m) => m.teacherId).filter((x): x is string => Boolean(x));
    const studentIds = members.map((m) => m.studentId).filter((x): x is string => Boolean(x));
    if (!teacherIds.length || !studentIds.length) return () => false;
    const links = await this.prisma.teacherStudent.findMany({
      where: { teacherId: { in: teacherIds }, studentId: { in: studentIds } },
      select: { teacherId: true, studentId: true },
    });
    const set = new Set(links.map((l) => `${l.teacherId}:${l.studentId}`));
    return (teacherId: string, studentId: string) => set.has(`${teacherId}:${studentId}`);
  }

  /** The requested members the caller may reach; refuses the lot if any is out of reach. */
  private async reachable(tenantId: string, self: ChatMember, ids: string[]) {
    const wanted = [...new Set(ids)].filter((id) => id !== self.membershipId);
    if (wanted.length === 0) return [];
    const rows = await this.prisma.membership.findMany({ where: { id: { in: wanted }, tenantId }, select: memberSelect });
    const members = rows.map(toChatMember);
    const teaches = await this.teachesFor([self, ...members]);
    if (members.length !== wanted.length || members.some((m) => !canMessage(self, m, teaches))) {
      throw new ForbiddenException(msg('messages.cannotMessage'));
    }
    return wanted;
  }

  /** A direct chat stays usable only while the pair may still talk (not blocked, still teacher and student). */
  private async assertCanStillMessage(user: JwtUser, otherId: string | undefined) {
    if (!otherId) throw new BadRequestException(msg('messages.recipientUnavailable'));
    const self = await this.member(user.tenantId!, me(user));
    const other = await this.member(user.tenantId!, otherId).catch(() => null);
    if (!other || !canMessage(self, other, await this.teachesFor([self, other]))) {
      throw new ForbiddenException(msg('messages.recipientUnavailable'));
    }
    return { self, other };
  }

  private async addParticipants(conversationId: string, ids: string[], announce: boolean, actorId?: string) {
    const present = new Set(
      (await this.prisma.conversationParticipant.findMany({ where: { conversationId, membershipId: { in: ids } }, select: { membershipId: true } })).map((p) => p.membershipId),
    );
    const fresh = ids.filter((id) => !present.has(id));
    if (fresh.length === 0) return [];
    await this.prisma.$transaction(async (tx) => {
      await tx.conversationParticipant.createMany({ data: fresh.map((membershipId) => ({ conversationId, membershipId })), skipDuplicates: true });
      if (announce && actorId) {
        const names = await tx.membership.findMany({ where: { id: { in: fresh } }, select: { user: { select: { fullName: true } } } });
        const tenantId = (await tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { tenantId: true } })).tenantId;
        await this.systemMessage(tx, conversationId, tenantId, actorId, { event: 'added', members: names.map((n) => n.user.fullName) });
      }
    });
    return fresh;
  }

  /** "Created the group", "added …": a message without a body, told by the client from `params`. */
  private async systemMessage(
    tx: Prisma.TransactionClient,
    conversationId: string,
    tenantId: string,
    actorId: string,
    params: Record<string, unknown>,
    opts: { countUnread?: boolean } = {},
  ) {
    const actor = await tx.membership.findUnique({ where: { id: actorId }, select: { user: { select: { fullName: true } } } });
    const m = await tx.message.create({
      data: { conversationId, tenantId, senderId: actorId, kind: 'SYSTEM', body: '', params: { ...params, actor: actor?.user.fullName ?? '' } as Prisma.InputJsonValue },
      select: { createdAt: true },
    });
    if (opts.countUnread) await this.afterMessage(tx, conversationId, actorId, m.createdAt);
    else await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: m.createdAt } });
  }

  /** A new message: the inbox order moves, the others get a badge (and it leaves their archive). */
  private async afterMessage(tx: Prisma.TransactionClient, conversationId: string, senderId: string, at: Date) {
    await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: at } });
    await tx.conversationParticipant.updateMany({
      where: { conversationId, membershipId: { not: senderId } },
      data: { unreadCount: { increment: 1 }, archivedAt: null },
    });
    await tx.conversationParticipant.updateMany({
      where: { conversationId, membershipId: senderId },
      data: { unreadCount: 0, lastReadAt: at, archivedAt: null },
    });
  }

  private async byClientId(senderId: string, clientId: string) {
    const m = await this.prisma.message.findUnique({ where: { senderId_clientId: { senderId, clientId } }, select: messageSelect });
    return m ? presentMessage(m) : null;
  }

  private async participantIds(conversationId: string) {
    const rows = await this.prisma.conversationParticipant.findMany({ where: { conversationId }, select: { membershipId: true } });
    return rows.map((r) => r.membershipId);
  }

  private async pushMessage(row: MessageRow) {
    const presented = presentMessage(row);
    this.realtime.toChat(await this.participantIds(row.conversationId), RealtimeEvent.messageUpdated, { conversationId: row.conversationId, message: presented });
    return presented;
  }

  private async pushUpdated(conversationId: string) {
    this.realtime.toChat(await this.participantIds(conversationId), RealtimeEvent.conversationUpdated, { conversationId });
  }
}

const me = (user: JwtUser) => user.membershipId!;

function toChatMember(row: MemberRow): ChatMember {
  return { membershipId: row.id, role: row.role, status: row.status, teacherId: row.teacher?.id ?? null, studentId: row.student?.id ?? null };
}

/** The API shape of a message; a deleted one keeps only its place. */
export function presentMessage(m: MessageRow) {
  const deleted = Boolean(m.deletedAt);
  return {
    id: m.id,
    conversationId: m.conversationId,
    kind: m.kind,
    body: deleted ? '' : m.body,
    params: m.params,
    senderId: m.senderId,
    sender: m.sender ? { fullName: m.sender.user.fullName, role: m.sender.role } : null,
    clientId: m.clientId,
    replyTo:
      m.replyTo && !deleted
        ? { id: m.replyTo.id, body: m.replyTo.deletedAt ? '' : m.replyTo.body.slice(0, PREVIEW), deleted: Boolean(m.replyTo.deletedAt), senderName: m.replyTo.sender?.user.fullName ?? null }
        : null,
    editedAt: m.editedAt,
    deletedAt: m.deletedAt,
    createdAt: m.createdAt,
    call: m.call ? presentCall(m.call) : null,
  };
}

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
