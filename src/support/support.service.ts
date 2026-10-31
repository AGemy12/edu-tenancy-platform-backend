import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from '../auth/auth.service.js';
import { MailService } from '../mail/mail.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { Locale } from '../i18n/locale.js';
import { msg } from '../i18n/i18n.js';
import type { ListSupportQueryDto, RequestSupportDto } from './dto/support.dto.js';
import { NotificationEvents } from '../notifications/notification-events.js';
import { PENDING_HOURS, SESSION_MINUTES, accessUntil, requestState, sessionEnd } from './support-rules.js';

const requestSelect = {
  id: true,
  tenantId: true,
  membershipId: true,
  targetName: true,
  targetEmail: true,
  targetRole: true,
  reason: true,
  minutes: true,
  status: true,
  createdAt: true,
  decidedAt: true,
  accessUntil: true,
  requestedBy: { select: { fullName: true, email: true } },
  decidedBy: { select: { fullName: true } },
} as const;

/**
 * Support mode: a platform admin works inside a center as one of its members, to see what they
 * see and fix it with the center's own screens and rules. The center decides: the platform sends
 * a request, the center's admin approves it for a window (or denies it), and support enters only
 * inside that window, as the member named in the request. Sessions are time-limited, every write
 * is logged (`SupportAuditInterceptor`), and what belongs to the person rather than the center
 * stays off limits (`@DenyInSupport`). The center can revoke an approval at any time.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly events: NotificationEvents,
  ) {}

  /* ── Platform side ── */

  /** Asks the center to let support in, and tells its admins. Nobody enters before one approves. */
  async request(actor: JwtUser, dto: RequestSupportDto, locale?: Locale) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: dto.tenantId }, select: { id: true, name: true, status: true } });
    if (!tenant) throw new NotFoundException(msg('tenants.notFound'));
    if (tenant.status !== 'ACTIVE') throw new BadRequestException(msg('support.tenantSuspended'));

    const member = await this.prisma.membership.findFirst({
      where: dto.membershipId
        ? { id: dto.membershipId, tenantId: tenant.id }
        : { tenantId: tenant.id, role: 'TENANT_ADMIN', status: { not: 'BLOCKED' } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, status: true, user: { select: { fullName: true, email: true } } },
    });
    if (!member) throw dto.membershipId ? new NotFoundException(msg('support.memberNotFound')) : new BadRequestException(msg('support.noAdmin'));
    if (member.status === 'BLOCKED') throw new BadRequestException(msg('support.memberBlocked'));

    const request = await this.prisma.supportRequest.create({
      data: {
        tenantId: tenant.id,
        requestedById: actor.id,
        membershipId: member.id,
        targetName: member.user.fullName,
        targetEmail: member.user.email,
        targetRole: member.role,
        reason: dto.reason.trim(),
        minutes: dto.minutes ?? SESSION_MINUTES.default,
      },
      select: requestSelect,
    });
    await this.notifyAdmins(request, tenant.name, locale);
    void this.events.supportRequested(request.id);
    return this.present(request);
  }

  /** Super admin: requests, newest first, optionally for one center. */
  async listRequests(q: ListSupportQueryDto) {
    const rows = await this.prisma.supportRequest.findMany({
      where: q.tenantId ? { tenantId: q.tenantId } : {},
      orderBy: { createdAt: 'desc' },
      take: q.take ?? 50,
      select: { ...requestSelect, _count: { select: { sessions: true } } },
    });
    return rows.map(({ _count, ...r }) => ({ ...this.present(r), sessions: _count.sessions }));
  }

  /** Super admin: withdraws a request (and closes its sessions) while it is still open. */
  async cancel(id: string) {
    const r = await this.prisma.supportRequest.findUnique({ where: { id }, select: requestSelect });
    if (!r) throw new NotFoundException(msg('support.requestNotFound'));
    const state = requestState(r);
    if (state !== 'PENDING' && state !== 'APPROVED') throw new ConflictException(msg('support.notActive'));
    await this.prisma.supportRequest.update({ where: { id }, data: { status: 'CANCELED' } });
    await this.endSessionsOf(id);
    return { ok: true };
  }

  /** Enters the center under an approved request; returns the token pair that signs the admin in as the member. */
  async start(actor: JwtUser, requestId: string) {
    const r = await this.prisma.supportRequest.findUnique({
      where: { id: requestId },
      select: { ...requestSelect, tenant: { select: { status: true } }, membership: { select: { id: true, status: true, userId: true } } },
    });
    if (!r) throw new NotFoundException(msg('support.requestNotFound'));
    if (requestState(r) !== 'APPROVED' || !r.accessUntil) throw new BadRequestException(msg('support.notApproved'));
    if (r.tenant.status !== 'ACTIVE') throw new BadRequestException(msg('support.tenantSuspended'));
    if (!r.membership) throw new NotFoundException(msg('support.memberNotFound'));
    if (r.membership.status === 'BLOCKED') throw new BadRequestException(msg('support.memberBlocked'));

    const session = await this.prisma.supportSession.create({
      data: {
        actorId: actor.id,
        tenantId: r.tenantId,
        membershipId: r.membership.id,
        requestId: r.id,
        targetName: r.targetName,
        targetEmail: r.targetEmail,
        targetRole: r.targetRole,
        reason: r.reason,
        expiresAt: sessionEnd({ minutes: r.minutes, accessUntil: r.accessUntil }),
      },
      select: { id: true },
    });
    this.logger.log(`Support session ${session.id}: ${actor.email} as membership ${r.membership.id} in tenant ${r.tenantId} (request ${r.id})`);
    return this.auth.issueSupportTokens(r.membership.userId, r.membership.id, session.id);
  }

  /** Closes the caller's own support session (leaving support mode). */
  async endCurrent(user: JwtUser) {
    if (!user.supportSessionId) throw new BadRequestException(msg('support.notInSupport'));
    return this.end(user.supportSessionId);
  }

  /** Closes a session now: its tokens stop working on the next request. */
  async end(id: string) {
    const session = await this.prisma.supportSession.findUnique({ where: { id }, select: { id: true } });
    if (!session) throw new NotFoundException(msg('support.notFound'));
    await this.closeSessions({ id });
    return { ok: true };
  }

  /** Super admin: the session log, newest first, optionally one center's or only open sessions. */
  async list(q: ListSupportQueryDto) {
    const now = new Date();
    const rows = await this.prisma.supportSession.findMany({
      where: {
        ...(q.tenantId && { tenantId: q.tenantId }),
        ...(q.active && { endedAt: null, expiresAt: { gt: now } }),
      },
      orderBy: { startedAt: 'desc' },
      take: q.take ?? 50,
      select: {
        id: true,
        reason: true,
        startedAt: true,
        expiresAt: true,
        endedAt: true,
        targetName: true,
        targetEmail: true,
        targetRole: true,
        actor: { select: { fullName: true, email: true } },
        tenant: { select: { id: true, name: true, slug: true } },
        _count: { select: { actions: true } },
      },
    });
    return rows.map(({ _count, ...s }) => ({ ...s, actions: _count.actions, active: !s.endedAt && s.expiresAt > now }));
  }

  /** What one session changed, oldest first; `tenantId` keeps a center to its own sessions. */
  async actions(id: string, tenantId?: string) {
    const session = await this.prisma.supportSession.findFirst({ where: { id, ...(tenantId && { tenantId }) }, select: { id: true } });
    if (!session) throw new NotFoundException(msg('support.notFound'));
    return this.prisma.supportAction.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, method: true, path: true, status: true, createdAt: true },
    });
  }

  /* ── Center side (its admins) ── */

  /** The center's requests with their sessions and what each changed, newest first. */
  async forCenter(user: JwtUser) {
    const rows = await this.prisma.supportRequest.findMany({
      where: { tenantId: user.tenantId! },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        ...requestSelect,
        sessions: {
          orderBy: { startedAt: 'desc' },
          select: { id: true, startedAt: true, expiresAt: true, endedAt: true, actor: { select: { fullName: true } }, _count: { select: { actions: true } } },
        },
      },
    });
    const now = new Date();
    return rows.map(({ sessions, ...r }) => ({
      ...this.present(r, now),
      sessions: sessions.map(({ _count, ...s }) => ({ ...s, actions: _count.actions, active: !s.endedAt && s.expiresAt > now })),
    }));
  }

  /** Lets support in for `hours`, as the member the request names. */
  async approve(user: JwtUser, id: string, hours: number) {
    await this.pendingOf(user, id);
    const now = new Date();
    const r = await this.prisma.supportRequest.update({
      where: { id },
      data: { status: 'APPROVED', decidedById: user.id, decidedAt: now, accessUntil: accessUntil(hours, now) },
      select: requestSelect,
    });
    this.logger.log(`Support request ${id} approved by user ${user.id} for ${hours}h`);
    void this.events.supportDecided(id, user.id);
    return this.present(r);
  }

  async deny(user: JwtUser, id: string) {
    await this.pendingOf(user, id);
    const r = await this.prisma.supportRequest.update({
      where: { id },
      data: { status: 'DENIED', decidedById: user.id, decidedAt: new Date() },
      select: requestSelect,
    });
    void this.events.supportDecided(id, user.id);
    return this.present(r);
  }

  /** Closes an approval early: support is signed out of the center right away. */
  async revoke(user: JwtUser, id: string) {
    const r = await this.prisma.supportRequest.findFirst({ where: { id, tenantId: user.tenantId! }, select: requestSelect });
    if (!r) throw new NotFoundException(msg('support.requestNotFound'));
    if (requestState(r) !== 'APPROVED') throw new ConflictException(msg('support.notActive'));
    const updated = await this.prisma.supportRequest.update({ where: { id }, data: { status: 'REVOKED' }, select: requestSelect });
    await this.endSessionsOf(id);
    return this.present(updated);
  }

  /* ── Helpers ── */

  private async pendingOf(user: JwtUser, id: string) {
    const r = await this.prisma.supportRequest.findFirst({ where: { id, tenantId: user.tenantId! }, select: requestSelect });
    if (!r) throw new NotFoundException(msg('support.requestNotFound'));
    if (requestState(r) !== 'PENDING') throw new ConflictException(msg('support.alreadyDecided'));
    return r;
  }

  private present<T extends { status: Parameters<typeof requestState>[0]['status']; createdAt: Date; accessUntil: Date | null }>(r: T, now = new Date()) {
    return { ...r, state: requestState(r, now) };
  }

  private endSessionsOf(requestId: string) {
    return this.closeSessions({ requestId });
  }

  private async closeSessions(where: { id: string } | { requestId: string }) {
    const now = new Date();
    const sessions = await this.prisma.supportSession.findMany({ where: { ...where, endedAt: null }, select: { id: true } });
    const ids = sessions.map((s) => s.id);
    if (!ids.length) return;
    await this.prisma.$transaction([
      this.prisma.supportSession.updateMany({ where: { id: { in: ids }, endedAt: null }, data: { endedAt: now } }),
      this.prisma.refreshToken.updateMany({ where: { supportSessionId: { in: ids }, revokedAt: null }, data: { revokedAt: now } }),
    ]);
  }

  /** Emails every active admin of the center; best effort, a mail failure never undoes the request. */
  private async notifyAdmins(
    r: { id: string; tenantId: string; targetName: string; targetRole: string; reason: string; requestedBy: { fullName: string } },
    tenantName: string,
    locale?: Locale,
  ) {
    const admins = await this.prisma.membership.findMany({
      where: { tenantId: r.tenantId, role: 'TENANT_ADMIN', status: 'ACTIVE' },
      select: { user: { select: { email: true, fullName: true } } },
    });
    const app = (this.config.get<string>('APP_URL') ?? 'http://localhost:3000').replace(/\/$/, '');
    const lang = locale ?? 'ar';
    for (const a of admins) {
      try {
        await this.mail.sendSupportRequest(
          {
            to: a.user.email,
            fullName: a.user.fullName,
            tenant: tenantName,
            actor: r.requestedBy.fullName,
            target: r.targetName,
            role: r.targetRole as 'TENANT_ADMIN' | 'TEACHER' | 'STUDENT',
            reason: r.reason,
            url: `${app}/${lang}/dashboard/settings#support`,
            hours: PENDING_HOURS,
          },
          lang,
        );
      } catch (err) {
        this.logger.warn(`Support request ${r.id}: email to ${a.user.email} failed: ${String(err)}`);
      }
    }
  }
}
