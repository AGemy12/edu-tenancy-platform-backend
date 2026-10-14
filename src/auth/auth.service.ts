import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import { TRIAL_PLAN_CODE } from '../plans/plans.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { AccountStatus, Role } from '../generated/prisma/enums.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type {
  ChangePasswordDto,
  CreateTenantDto,
  LoginDto,
  RegisterTenantDto,
  SwitchMembershipDto,
  UpdateProfileDto,
} from './dto/auth.dto.js';
import { msg } from '../i18n/i18n.js';
import { DEFAULT_LOCALE, type Locale } from '../i18n/locale.js';

/**
 * One sign-in, many centers. A `User` is the identity (email, password, name); each
 * `Membership` is what that person is in one center. A session is signed into exactly one
 * membership (or, for the platform operator, into no center at all): the JWT carries it as
 * `mid`, and `/auth/switch` moves the session to another one.
 */

const userSelect = {
  id: true,
  email: true,
  fullName: true,
  phone: true,
  isPlatformAdmin: true,
  lastMembershipId: true,
  memberships: {
    select: {
      id: true,
      role: true,
      status: true,
      statusReason: true,
      tenant: { select: { id: true, name: true, slug: true, status: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;
type MembershipRow = UserRow['memberships'][number];

type TenantLite = { id: string; name: string; slug: string };

/** What the client gets: who they are, the center they are signed into, and the others they can open. */
export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  isPlatformAdmin: boolean;
  membershipId: string | null;
  role: Role;
  status: AccountStatus;
  statusReason: string | null;
  tenantId: string | null;
  tenant: TenantLite | null;
  memberships: { id: string; role: Role; status: AccountStatus; tenant: TenantLite; usable: boolean }[];
};

/** A center the user can sign into right now. */
const usable = (m: MembershipRow) => m.status !== 'BLOCKED' && m.tenant.status === 'ACTIVE';

function present(user: UserRow, membershipId: string | null): SessionUser {
  const active = membershipId ? (user.memberships.find((m) => m.id === membershipId) ?? null) : null;
  const lite = (t: MembershipRow['tenant']): TenantLite => ({ id: t.id, name: t.name, slug: t.slug });
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    isPlatformAdmin: user.isPlatformAdmin,
    membershipId: active?.id ?? null,
    role: active?.role ?? 'SUPER_ADMIN',
    status: active?.status ?? 'ACTIVE',
    statusReason: active?.statusReason ?? null,
    tenantId: active?.tenant.id ?? null,
    tenant: active ? lite(active.tenant) : null,
    memberships: user.memberships.map((m) => ({ id: m.id, role: m.role, status: m.status, tenant: lite(m.tenant), usable: usable(m) })),
  };
}

const RESET_TOKEN_MINUTES = 60;
/** How long the link in a new member's welcome email stays valid. */
const WELCOME_TOKEN_DAYS = 7;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  /** A brand-new account and its first center. Someone who already has an account creates centers from inside it. */
  async registerTenant(dto: RegisterTenantDto) {
    const email = dto.email.toLowerCase();
    await this.assertSlugFree(dto.tenantSlug);
    const emailTaken = await this.prisma.user.findUnique({ where: { email } });
    if (emailTaken) throw new ConflictException(msg('auth.emailRegistered'));

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const membershipId = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email, passwordHash, fullName: dto.fullName }, select: { id: true } });
      const membership = await this.createTenantFor(tx, user.id, dto);
      return membership.id;
    });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { email }, select: userSelect });
    return this.issueTokens(user, membershipId, true);
  }

  /**
   * A signed-in user opens another center of their own (owner there too), and the session moves
   * into it. Any account may, whatever it is elsewhere, within two limits that stop free trials
   * being farmed: at most MAX_OWNED_CENTERS centers owned, and one running trial at a time.
   */
  async createTenant(user: JwtUser, dto: CreateTenantDto) {
    await this.assertSlugFree(dto.tenantSlug);
    const max = Number(this.config.get('MAX_OWNED_CENTERS') ?? 3);
    const owned = await this.prisma.membership.findMany({
      where: { userId: user.id, role: 'TENANT_ADMIN' },
      select: { tenant: { select: { subscription: { select: { status: true, currentPeriodEnd: true } } } } },
    });
    if (owned.length >= max) throw new ConflictException(msg('auth.tooManyCenters', { max }));
    const now = new Date();
    if (owned.some((o) => o.tenant.subscription?.status === 'TRIALING' && (o.tenant.subscription.currentPeriodEnd === null || o.tenant.subscription.currentPeriodEnd > now))) {
      throw new ConflictException(msg('auth.trialInProgress'));
    }
    const membership = await this.prisma.$transaction((tx) => this.createTenantFor(tx, user.id, dto));
    return this.switch(user, { membershipId: membership.id, refreshToken: dto.refreshToken });
  }

  private async assertSlugFree(slug: string) {
    const slugTaken = await this.prisma.tenant.findUnique({ where: { slug } });
    if (slugTaken) throw new ConflictException(msg('auth.slugTaken'));
  }

  /** The center, its trial subscription and the owner's membership. */
  private async createTenantFor(tx: Prisma.TransactionClient, userId: string, dto: { tenantName: string; tenantSlug: string }) {
    const periodEnd = new Date();
    periodEnd.setDate(periodEnd.getDate() + 14); // 14-day trial
    const tenant = await tx.tenant.create({
      data: {
        name: dto.tenantName,
        slug: dto.tenantSlug,
        subscription: { create: { currentPeriodEnd: periodEnd, plan: { connect: { code: TRIAL_PLAN_CODE } } } },
      },
    });
    const membership = await tx.membership.create({ data: { userId, tenantId: tenant.id, role: 'TENANT_ADMIN' } });
    await tx.user.update({ where: { id: userId }, data: { lastMembershipId: membership.id } });
    return membership;
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      select: { ...userSelect, passwordHash: true },
    });
    if (!user) throw new UnauthorizedException(msg('auth.invalidCredentials'));
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException(msg('auth.invalidCredentials'));

    const membershipId = this.defaultContext(user);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const { passwordHash: _ph, ...row } = user;
    return this.issueTokens(row, membershipId, Boolean(dto.rememberMe));
  }

  /**
   * Where a sign-in lands: the center opened last, else the first usable one (the platform
   * console for an operator without centers). The client shows the space picker whenever
   * there is more than one place to go.
   */
  private defaultContext(user: UserRow) {
    const open = user.memberships.filter(usable);
    if (open.length === 0 && !user.isPlatformAdmin) {
      if (user.memberships.some((m) => m.status === 'BLOCKED')) throw new UnauthorizedException(msg('auth.blocked'));
      if (user.memberships.some((m) => m.tenant.status !== 'ACTIVE')) throw new UnauthorizedException(msg('auth.tenantSuspended'));
      throw new UnauthorizedException(msg('auth.noCenter'));
    }
    const last = open.find((m) => m.id === user.lastMembershipId) ?? null;
    return last?.id ?? (user.isPlatformAdmin ? null : open[0].id);
  }

  /** Moves the session to another of the user's centers (or, for an operator, to the platform console). */
  async switch(user: JwtUser, dto: SwitchMembershipDto) {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: userSelect });
    const membershipId = dto.membershipId ?? null;
    if (membershipId) {
      const m = row.memberships.find((x) => x.id === membershipId);
      if (!m) throw new NotFoundException(msg('auth.membershipNotFound'));
      if (m.status === 'BLOCKED') throw new UnauthorizedException(msg('auth.blocked'));
      if (m.tenant.status !== 'ACTIVE') throw new UnauthorizedException(msg('auth.tenantSuspended'));
    } else if (!row.isPlatformAdmin) {
      throw new ForbiddenException(msg('auth.forbidden'));
    }

    // The session keeps its "remember me" lifetime; the old refresh token is retired.
    let remember = false;
    if (dto.refreshToken) {
      const old = await this.prisma.refreshToken.findUnique({ where: { tokenHash: this.hash(dto.refreshToken) } });
      if (old && old.userId === user.id) {
        remember = old.remember;
        await this.prisma.refreshToken.update({ where: { id: old.id }, data: { revokedAt: new Date() } });
      }
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastMembershipId: membershipId } });
    return this.issueTokens(row, membershipId, remember);
  }

  async refresh(rawToken: string) {
    const tokenHash = this.hash(rawToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { select: userSelect } },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException(msg('auth.invalidSession'));
    }
    // A membership that was blocked, removed, or whose center was suspended ends the session.
    if (stored.membershipId) {
      const m = stored.user.memberships.find((x) => x.id === stored.membershipId);
      if (!m || !usable(m)) throw new UnauthorizedException(msg('auth.invalidSession'));
    } else if (!stored.user.isPlatformAdmin) {
      throw new UnauthorizedException(msg('auth.invalidSession'));
    }
    // Rotate: revoke old, issue new with the same "remember me" lifetime.
    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(stored.user, stored.membershipId, stored.remember);
  }

  async logout(rawToken: string) {
    const tokenHash = this.hash(rawToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(user: JwtUser) {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: userSelect });
    return present(row, user.membershipId);
  }

  /** Name and phone are free to change; the login email needs the current password. */
  async updateProfile(user: JwtUser, dto: UpdateProfileDto) {
    const data: { fullName?: string; phone?: string | null; email?: string } = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName.trim();
    if (dto.phone !== undefined) data.phone = dto.phone?.trim() || null;

    const email = dto.email?.trim().toLowerCase();
    if (email) {
      const current = await this.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { email: true, passwordHash: true },
      });
      if (email !== current.email) {
        if (!dto.currentPassword) throw new BadRequestException(msg('auth.passwordRequiredForEmail'));
        if (!(await bcrypt.compare(dto.currentPassword, current.passwordHash))) {
          throw new BadRequestException(msg('auth.wrongPassword'));
        }
        const taken = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
        if (taken) throw new ConflictException(msg('users.emailInUse'));
        data.email = email;
      }
    }

    const row = await this.prisma.user.update({ where: { id: user.id }, data, select: userSelect });
    return present(row, user.membershipId);
  }

  /** Keeps the caller's own session (when its refresh token is sent) and signs out every other device. */
  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new BadRequestException(msg('auth.wrongPassword'));
    }
    if (dto.currentPassword === dto.newPassword) throw new BadRequestException(msg('auth.samePassword'));

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    const keep = dto.refreshToken ? this.hash(dto.refreshToken) : undefined;
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null, ...(keep ? { tokenHash: { not: keep } } : {}) },
        data: { revokedAt: new Date() },
      }),
    ]);
    this.logger.log(`Password changed for user ${userId}`);
    return { ok: true };
  }

  /**
   * Always resolves successfully so the endpoint cannot be used to discover
   * registered emails. In development without SMTP the link is also returned.
   */
  async forgotPassword(email: string, locale: Locale = DEFAULT_LOCALE): Promise<{ ok: true; devResetUrl?: string }> {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return { ok: true };

    const resetUrl = await this.passwordLink(user.id, RESET_TOKEN_MINUTES, locale);
    await this.mail.sendPasswordReset(user.email, user.fullName, resetUrl, RESET_TOKEN_MINUTES, locale);

    const exposeLink = !this.mail.configured && this.config.get('NODE_ENV') !== 'production';
    return exposeLink ? { ok: true, devResetUrl: resetUrl } : { ok: true };
  }

  /**
   * Tells a new teacher or student about their place in the center: a link to choose a password
   * for a brand-new account, or just "sign in as usual" when they already had one.
   * Best effort: a mail failure is logged and never undoes the account.
   */
  async sendWelcome(membershipId: string, opts: { existingAccount: boolean }, locale: Locale = DEFAULT_LOCALE) {
    try {
      const m = await this.prisma.membership.findUniqueOrThrow({
        where: { id: membershipId },
        select: { role: true, user: { select: { id: true, email: true, fullName: true } }, tenant: { select: { name: true } } },
      });
      if (m.role !== 'TEACHER' && m.role !== 'STUDENT') return;
      const url = opts.existingAccount ? null : await this.passwordLink(m.user.id, WELCOME_TOKEN_DAYS * 24 * 60, locale);
      await this.mail.sendWelcome(
        {
          to: m.user.email,
          fullName: m.user.fullName,
          tenant: m.tenant.name,
          role: m.role,
          url,
          loginUrl: `${this.appUrl()}/${locale}/login`,
          days: WELCOME_TOKEN_DAYS,
        },
        locale,
      );
    } catch (err) {
      this.logger.warn(`Welcome email for membership ${membershipId} failed: ${String(err)}`);
    }
  }

  /** A one-time link to the reset-password page; it replaces any earlier unused link. */
  private async passwordLink(userId: string, minutes: number, locale: Locale) {
    await this.prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    const raw = randomBytes(32).toString('base64url');
    await this.prisma.passwordResetToken.create({
      data: { userId, tokenHash: this.hash(raw), expiresAt: new Date(Date.now() + minutes * 60_000) },
    });
    // Frontend routes are prefixed with the locale (/ar/..., /en/...).
    return `${this.appUrl()}/${locale}/reset-password?token=${raw}`;
  }

  private appUrl() {
    return (this.config.get<string>('APP_URL') ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  async resetPassword(rawToken: string, password: string) {
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: this.hash(rawToken) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException(msg('auth.invalidResetLink'));
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
      this.prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      // Sign out every device.
      this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    this.logger.log(`Password reset for user ${record.userId}`);
    return { ok: true };
  }

  private async issueTokens(user: UserRow, membershipId: string | null, remember: boolean) {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, mid: membershipId },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: (this.config.get<string>('JWT_ACCESS_TTL') ?? '15m') as JwtSignOptions['expiresIn'],
      },
    );

    const refreshToken = randomBytes(48).toString('base64url');
    const days = Number(this.config.get('JWT_REFRESH_TTL_DAYS') ?? 30);
    const hours = Number(this.config.get('JWT_REFRESH_SESSION_TTL_HOURS') ?? 24);
    const ttlMs = remember ? days * 24 * 60 * 60 * 1000 : hours * 60 * 60 * 1000;
    await this.prisma.refreshToken.create({
      data: { userId: user.id, membershipId, tokenHash: this.hash(refreshToken), expiresAt: new Date(Date.now() + ttlMs), remember },
    });

    return { accessToken, refreshToken, user: present(user, membershipId), rememberMe: remember };
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
