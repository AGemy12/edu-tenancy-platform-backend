import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import type { AccountStatus, NotificationType } from '../generated/prisma/enums.js';
import { NotificationsService, type NotifyParams } from './notifications.service.js';

const SESSIONS = '/dashboard/sessions';

/**
 * Every event in the platform that someone should hear about, in one place: each method loads
 * what its message needs and sends it. Services call these after their change is saved, without
 * awaiting (`void this.events.x(...)`): nothing here can fail the request.
 */
@Injectable()
export class NotificationEvents {
  private readonly logger = new Logger(NotificationEvents.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
  ) {}

  /* ── Sessions ── */

  /** A session was booked: its students, and its teacher when someone else booked it. */
  sessionScheduled(sessionId: string, actorId: string) {
    return this.session('SESSION_SCHEDULED', sessionId, actorId, { teacher: true });
  }

  sessionRescheduled(sessionId: string, actorId: string) {
    return this.session('SESSION_RESCHEDULED', sessionId, actorId, { teacher: true });
  }

  sessionCanceled(sessionId: string, actorId: string | null) {
    return this.session('SESSION_CANCELED', sessionId, actorId, { teacher: true });
  }

  /** The teacher opened the meeting: students can join now. */
  sessionLive(sessionId: string, actorId: string | null) {
    return this.session('SESSION_LIVE', sessionId, actorId, { teacher: false });
  }

  /** Starting soon (see NotificationJobs); `minutes` until the start. */
  sessionReminder(sessionId: string, minutes: number) {
    return this.session('SESSION_REMINDER', sessionId, null, { teacher: true, params: { minutes }, dedupe: `reminder:${sessionId}` });
  }

  /** The teacher saved their evaluation: each evaluated student can read it. */
  sessionEvaluated(sessionId: string, studentIds: string[], actorId: string) {
    return this.session('SESSION_EVALUATED', sessionId, actorId, { teacher: false, studentIds });
  }

  private async session(
    type: 'SESSION_SCHEDULED' | 'SESSION_RESCHEDULED' | 'SESSION_CANCELED' | 'SESSION_LIVE' | 'SESSION_REMINDER' | 'SESSION_EVALUATED',
    sessionId: string,
    actorId: string | null,
    opts: { teacher: boolean; studentIds?: string[]; params?: Record<string, number>; dedupe?: string },
  ) {
    await this.safely(type, async () => {
      const s = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: {
          tenantId: true,
          title: true,
          startAt: true,
          teacher: { select: { membershipId: true, user: { select: { fullName: true } } } },
          attendees: {
            where: opts.studentIds ? { studentId: { in: opts.studentIds } } : {},
            select: { student: { select: { membershipId: true, user: { select: { fullName: true } } } } },
          },
        },
      });
      if (!s) return;
      const told = [...(opts.teacher ? [s.teacher.membershipId] : []), ...s.attendees.map((a) => a.student.membershipId)];
      const params = { title: s.title, at: s.startAt.toISOString(), teacher: s.teacher.user.fullName };
      await this.notifications.send({ type, memberships: told, params: { ...params, ...opts.params }, link: SESSIONS, actorId, dedupe: opts.dedupe });
      // A reminder is for the people in the session; everything else the owner hears about too.
      if (type !== 'SESSION_REMINDER') {
        const students = s.attendees.map((a) => a.student.user.fullName);
        await this.oversee(s.tenantId, type, { ...params, student: students[0], count: students.length }, SESSIONS, actorId, told);
      }
    });
  }

  /** A month of sessions was booked for a student. */
  async scheduleCreated(scheduleId: string, actorId: string) {
    await this.safely('SCHEDULE_CREATED', async () => {
      const s = await this.prisma.studentSchedule.findUnique({
        where: { id: scheduleId },
        select: {
          tenantId: true,
          title: true,
          startDate: true,
          teacher: { select: { membershipId: true, user: { select: { fullName: true } } } },
          student: { select: { membershipId: true, user: { select: { fullName: true } } } },
          _count: { select: { sessions: true } },
        },
      });
      if (!s) return;
      const told = [s.student.membershipId, s.teacher.membershipId];
      const params = { title: s.title, teacher: s.teacher.user.fullName, count: s._count.sessions, from: s.startDate.toISOString().slice(0, 10) };
      await this.notifications.send({ type: 'SCHEDULE_CREATED', memberships: told, params, link: SESSIONS, actorId });
      await this.oversee(s.tenantId, 'SCHEDULE_CREATED', { ...params, student: s.student.user.fullName }, '/dashboard/schedules', actorId, told);
    });
  }

  /* ── Exams ── */

  /** Published: the course's students can see it. */
  async examPublished(examId: string, actorId: string) {
    await this.safely('EXAM_PUBLISHED', async () => {
      const e = await this.prisma.exam.findUnique({
        where: { id: examId },
        select: {
          tenantId: true,
          title: true,
          course: { select: { title: true, enrollments: { where: { status: 'ACTIVE' }, select: { student: { select: { membershipId: true } } } } } },
          teacher: { select: { membershipId: true, user: { select: { fullName: true } } } },
        },
      });
      if (!e) return;
      const told = e.course.enrollments.map((x) => x.student.membershipId);
      const params = { title: e.title, course: e.course.title, teacher: e.teacher.user.fullName };
      await this.notifications.send({ type: 'EXAM_PUBLISHED', memberships: told, params, link: '/dashboard/exams', actorId });
      await this.oversee(e.tenantId, 'EXAM_PUBLISHED', { ...params, count: told.length }, '/dashboard/exams', actorId, [...told, e.teacher.membershipId]);
    });
  }

  /** New or changed marks; students hear only once the exam is visible to them (not a draft). */
  async examGraded(examId: string, studentIds: string[], actorId: string) {
    if (studentIds.length === 0) return;
    await this.safely('EXAM_GRADED', async () => {
      const e = await this.prisma.exam.findUnique({
        where: { id: examId },
        select: {
          tenantId: true,
          title: true,
          status: true,
          totalMarks: true,
          course: { select: { title: true } },
          teacher: { select: { membershipId: true, user: { select: { fullName: true } } } },
          results: { where: { studentId: { in: studentIds } }, select: { score: true, student: { select: { membershipId: true } } } },
        },
      });
      if (!e || e.status === 'DRAFT') return;
      // One line for the owner per grading, not one per mark.
      await this.oversee(
        e.tenantId,
        'EXAM_GRADED',
        { title: e.title, course: e.course.title, teacher: e.teacher.user.fullName, count: e.results.length },
        '/dashboard/exams',
        actorId,
        [e.teacher.membershipId],
      );
      for (const r of e.results) {
        await this.notifications.send({
          type: 'EXAM_GRADED',
          memberships: [r.student.membershipId],
          params: { title: e.title, score: Number(r.score), total: e.totalMarks },
          link: '/dashboard/exams',
          actorId,
        });
      }
    });
  }

  /* ── Library ── */

  /** Files landed in students' folders: `counts` per student id. */
  async filesShared(counts: Map<string, number>, actorId: string) {
    if (counts.size === 0) return;
    await this.safely('FILES_SHARED', async () => {
      const [students, actor] = await Promise.all([
        this.prisma.student.findMany({ where: { id: { in: [...counts.keys()] } }, select: { id: true, tenantId: true, membershipId: true } }),
        this.prisma.user.findUnique({ where: { id: actorId }, select: { fullName: true } }),
      ]);
      for (const s of students) {
        await this.notifications.send({
          type: 'FILES_SHARED',
          memberships: [s.membershipId],
          params: { teacher: actor?.fullName ?? '', count: counts.get(s.id) ?? 0 },
          link: '/dashboard/library',
          actorId,
        });
      }
      const sent = [...counts.values()].reduce((a, b) => a + b, 0);
      if (students[0] && sent > 0) {
        const told = students.map((s) => s.membershipId);
        await this.oversee(students[0].tenantId, 'FILES_SHARED', { teacher: actor?.fullName ?? '', files: sent, count: students.length }, '/dashboard/library', actorId, told);
      }
    });
  }

  /* ── People ── */

  /** A teacher now teaches a student: each hears about the other. */
  async teacherLinked(teacherId: string, studentId: string, actorId: string) {
    await this.safely('TEACHER_ASSIGNED', async () => {
      const [teacher, student] = await Promise.all([
        this.prisma.teacher.findUnique({ where: { id: teacherId }, select: { tenantId: true, membershipId: true, user: { select: { fullName: true } } } }),
        this.prisma.student.findUnique({ where: { id: studentId }, select: { membershipId: true, user: { select: { fullName: true } } } }),
      ]);
      if (!teacher || !student) return;
      await this.notifications.send({
        type: 'TEACHER_ASSIGNED',
        memberships: [student.membershipId],
        params: { teacher: teacher.user.fullName },
        link: '/dashboard/messages',
        actorId,
      });
      await this.notifications.send({
        type: 'STUDENT_ASSIGNED',
        memberships: [teacher.membershipId],
        params: { student: student.user.fullName },
        link: '/dashboard/students',
        actorId,
      });
      await this.oversee(
        teacher.tenantId,
        'TEACHER_ASSIGNED',
        { teacher: teacher.user.fullName, student: student.user.fullName },
        '/dashboard/students',
        actorId,
        [teacher.membershipId, student.membershipId],
      );
    });
  }

  /** Suspended, blocked or reactivated. A blocked member's live connections close at once. */
  async accountStatus(membershipId: string, status: AccountStatus, reason: string | null | undefined, actorId: string) {
    if (status === 'BLOCKED') this.realtime.disconnectMember(membershipId);
    await this.safely('ACCOUNT_STATUS', async () => {
      const m = await this.prisma.membership.findUnique({
        where: { id: membershipId },
        select: { tenantId: true, role: true, user: { select: { fullName: true } }, tenant: { select: { name: true } } },
      });
      if (!m) return;
      const why = status === 'ACTIVE' ? null : reason?.trim() || null;
      await this.notifications.send({
        type: 'ACCOUNT_STATUS',
        memberships: [membershipId],
        params: { variant: status, tenant: m.tenant.name, reason: why },
        link: '/dashboard/profile',
        actorId,
      });
      const page = m.role === 'STUDENT' ? '/dashboard/students' : '/dashboard/teachers';
      await this.oversee(m.tenantId, 'ACCOUNT_STATUS', { variant: status, member: m.user.fullName, reason: why }, page, actorId, [membershipId]);
    });
  }

  /** A teacher or student joined the center (added by an admin, or a student by their teacher). */
  async memberAdded(membershipId: string, actorId: string) {
    await this.safely('MEMBER_ADDED', async () => {
      const m = await this.prisma.membership.findUnique({ where: { id: membershipId }, select: { tenantId: true, role: true, user: { select: { fullName: true } } } });
      if (!m || (m.role !== 'TEACHER' && m.role !== 'STUDENT')) return;
      const page = m.role === 'STUDENT' ? '/dashboard/students' : '/dashboard/teachers';
      await this.oversee(m.tenantId, 'MEMBER_ADDED', { variant: m.role, member: m.user.fullName }, page, actorId, [membershipId]);
    });
  }

  /**
   * An admin asks a teacher to link the account their sessions are created on. At most one
   * reminder a day per provider, however often the button is pressed.
   */
  async meetingAccountNeeded(membershipId: string, provider: 'ZOOM' | 'GOOGLE_MEET', actorId: string) {
    await this.safely('MEETING_ACCOUNT_NEEDED', async () => {
      const [m, actor] = await Promise.all([
        this.prisma.membership.findUnique({ where: { id: membershipId }, select: { tenant: { select: { name: true } } } }),
        this.prisma.user.findUnique({ where: { id: actorId }, select: { fullName: true } }),
      ]);
      if (!m) return;
      await this.notifications.send({
        type: 'MEETING_ACCOUNT_NEEDED',
        memberships: [membershipId],
        params: { variant: provider, tenant: m.tenant.name, actor: actor?.fullName ?? '' },
        link: '/dashboard/settings',
        actorId,
        dedupe: `meeting-account:${provider}:${new Date().toISOString().slice(0, 10)}`,
      });
    });
  }

  /** Taken out of the center: whatever they had open closes now. */
  memberRemoved(membershipId: string) {
    this.realtime.disconnectMember(membershipId);
  }

  /* ── Subscription ── */

  /** The platform changed the center's package, status or end date. */
  async subscriptionChanged(tenantId: string, actorId: string | null) {
    await this.safely('SUBSCRIPTION_CHANGED', async () => {
      const sub = await this.prisma.subscription.findUnique({
        where: { tenantId },
        select: { status: true, currentPeriodEnd: true, plan: { select: { nameAr: true, nameEn: true } } },
      });
      if (!sub) return;
      const variant = sub.status === 'CANCELED' ? 'CANCELED' : sub.currentPeriodEnd ? 'DATED' : 'OPEN';
      await this.notifications.send({
        type: 'SUBSCRIPTION_CHANGED',
        memberships: await this.centerAdmins(tenantId),
        params: { variant, planAr: sub.plan.nameAr, planEn: sub.plan.nameEn, end: sub.currentPeriodEnd?.toISOString() },
        link: '/dashboard/settings',
        actorId,
      });
    });
  }

  /** Runs out within days (`EXPIRING`) or has run out (`EXPIRED`); see NotificationJobs. */
  async subscriptionNotice(tenantId: string, kind: 'EXPIRING' | 'EXPIRED', end: Date) {
    await this.safely(`SUBSCRIPTION_${kind}`, async () => {
      const days = Math.max(Math.ceil((end.getTime() - Date.now()) / 86_400_000), 0);
      await this.notifications.send({
        type: kind === 'EXPIRING' ? 'SUBSCRIPTION_EXPIRING' : 'SUBSCRIPTION_EXPIRED',
        memberships: await this.centerAdmins(tenantId),
        params: { end: end.toISOString(), days },
        link: '/dashboard/settings',
        dedupe: `subscription:${kind}:${tenantId}:${end.toISOString()}`,
      });
    });
  }

  /* ── Platform support and centers ── */

  /** Platform support asks to come in: the center's admins decide. */
  async supportRequested(requestId: string) {
    await this.safely('SUPPORT_REQUESTED', async () => {
      const r = await this.prisma.supportRequest.findUnique({
        where: { id: requestId },
        select: { tenantId: true, requestedById: true, targetName: true, reason: true, requestedBy: { select: { fullName: true } } },
      });
      if (!r) return;
      await this.notifications.send({
        type: 'SUPPORT_REQUESTED',
        memberships: await this.centerAdmins(r.tenantId),
        params: { actor: r.requestedBy.fullName, target: r.targetName, reason: r.reason },
        link: '/dashboard/settings#support',
        actorId: r.requestedById,
      });
    });
  }

  /** The center answered: the platform admin who asked hears it. */
  async supportDecided(requestId: string, actorId: string) {
    await this.safely('SUPPORT_DECIDED', async () => {
      const r = await this.prisma.supportRequest.findUnique({
        where: { id: requestId },
        select: { status: true, requestedById: true, decidedAt: true, accessUntil: true, tenant: { select: { name: true } } },
      });
      if (!r || (r.status !== 'APPROVED' && r.status !== 'DENIED')) return;
      const hours = r.accessUntil && r.decidedAt ? Math.round((r.accessUntil.getTime() - r.decidedAt.getTime()) / 3_600_000) : null;
      await this.notifications.send({
        type: 'SUPPORT_DECIDED',
        consoleUsers: [r.requestedById],
        params: { variant: r.status, tenant: r.tenant.name, hours },
        link: '/dashboard/platform/centers',
        actorId,
      });
    });
  }

  /** A new center signed up on its own. */
  async tenantRegistered(tenantId: string, ownerId: string) {
    await this.safely('TENANT_REGISTERED', async () => {
      const [tenant, owner] = await Promise.all([
        this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
        this.prisma.user.findUnique({ where: { id: ownerId }, select: { fullName: true } }),
      ]);
      if (!tenant) return;
      await this.notifications.send({
        type: 'TENANT_REGISTERED',
        platformAdmins: true,
        params: { tenant: tenant.name, owner: owner?.fullName ?? '' },
        link: '/dashboard/platform/centers',
        actorId: ownerId,
      });
    });
  }

  /* ── Helpers ── */

  /**
   * The center's owner hears about everything that happens in it: its admins get a third-person
   * copy (category ACTIVITY, mutable on its own) unless they were told directly, or did it.
   */
  private async oversee(
    tenantId: string,
    type: NotificationType,
    params: NotifyParams,
    link: string,
    actorId: string | null,
    told: string[],
  ) {
    const admins = (await this.centerAdmins(tenantId)).filter((id) => !told.includes(id));
    if (admins.length === 0) return;
    await this.notifications.send({ type, memberships: admins, params, link, actorId, oversight: true });
  }

  async centerAdmins(tenantId: string) {
    const rows = await this.prisma.membership.findMany({ where: { tenantId, role: 'TENANT_ADMIN' }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  private async safely(what: string, run: () => Promise<void>) {
    try {
      await run();
    } catch (err) {
      this.logger.warn(`Notifying ${what} failed: ${String(err)}`);
    }
  }
}
