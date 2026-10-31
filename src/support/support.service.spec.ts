import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { vi } from 'vitest';
import { SupportService } from './support.service.js';
import { SupportGuard } from './support.guard.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { MailService } from '../mail/mail.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';

const admin: JwtUser = { id: 'admin', email: 'ops@x.test', role: 'SUPER_ADMIN', status: 'ACTIVE', tenantId: null, teacherId: null, studentId: null, membershipId: null };
const owner: JwtUser = { id: 'u1', email: 'owner@x.test', role: 'TENANT_ADMIN', status: 'ACTIVE', tenantId: 't1', teacherId: null, studentId: null, membershipId: 'm1' };
const ownerMember = { id: 'm1', role: 'TENANT_ADMIN', status: 'ACTIVE', user: { fullName: 'Owner', email: 'owner@x.test' } };
const hours = (h: number) => new Date(Date.now() + h * 3_600_000);

/** A request row as the service selects it. */
const request = (over: object = {}) => ({
  id: 'r1',
  tenantId: 't1',
  membershipId: 'm1',
  targetName: 'Owner',
  targetEmail: 'owner@x.test',
  targetRole: 'TENANT_ADMIN',
  reason: 'Schedule not saving',
  minutes: 60,
  status: 'PENDING',
  createdAt: new Date(),
  decidedAt: null,
  accessUntil: null,
  requestedBy: { fullName: 'Ops', email: 'ops@x.test' },
  decidedBy: null,
  ...over,
});

function setup() {
  const prisma = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ id: 't1', name: 'Center', status: 'ACTIVE' }) },
    membership: {
      findFirst: vi.fn().mockResolvedValue(ownerMember),
      findMany: vi.fn().mockResolvedValue([{ user: { email: 'owner@x.test', fullName: 'Owner' } }, { user: { email: 'co@x.test', fullName: 'Co' } }]),
    },
    supportRequest: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve(request(data))),
      findUnique: vi.fn().mockResolvedValue(request()),
      findFirst: vi.fn().mockResolvedValue(request()),
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve(request(data))),
    },
    supportSession: {
      create: vi.fn().mockResolvedValue({ id: 's1' }),
      findUnique: vi.fn().mockResolvedValue({ id: 's1' }),
      findMany: vi.fn().mockResolvedValue([{ id: 's1' }]),
      updateMany: vi.fn(),
    },
    refreshToken: { updateMany: vi.fn() },
    $transaction: vi.fn().mockResolvedValue([]),
  };
  const auth = { issueSupportTokens: vi.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }) };
  const mail = { sendSupportRequest: vi.fn() };
  const config = { get: () => 'https://app.test/' };
  const service = new SupportService(prisma as unknown as PrismaService, auth as unknown as AuthService, mail as unknown as MailService, config as never, new Proxy({}, { get: () => vi.fn() }) as never);
  return { prisma, auth, mail, service };
}

describe('SupportService.request (platform)', () => {
  it("asks for the center's first active admin by default and emails every active admin", async () => {
    const { prisma, mail, service } = setup();
    const res = await service.request(admin, { tenantId: 't1', reason: '  Schedule not saving  ' }, 'en');
    expect(prisma.membership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 't1', role: 'TENANT_ADMIN', status: { not: 'BLOCKED' } }, orderBy: { createdAt: 'asc' } }),
    );
    expect(prisma.supportRequest.create.mock.calls[0][0].data).toEqual({
      tenantId: 't1',
      requestedById: 'admin',
      membershipId: 'm1',
      targetName: 'Owner',
      targetEmail: 'owner@x.test',
      targetRole: 'TENANT_ADMIN',
      reason: 'Schedule not saving',
      minutes: 60,
    });
    expect(res.state).toBe('PENDING');
    expect(mail.sendSupportRequest).toHaveBeenCalledTimes(2);
    expect(mail.sendSupportRequest.mock.calls[0][0]).toMatchObject({ to: 'owner@x.test', tenant: 'Center', actor: 'Ops', url: 'https://app.test/en/dashboard/settings#support' });
  });

  it('asks for a chosen member of that center only, and refuses blocked members, suspended centers and centers with no admin', async () => {
    const a = setup();
    await a.service.request(admin, { tenantId: 't1', membershipId: 'm9', reason: 'Student cannot join', minutes: 15 });
    expect(a.prisma.membership.findFirst.mock.calls[0][0].where).toEqual({ id: 'm9', tenantId: 't1' });

    const b = setup();
    b.prisma.membership.findFirst.mockResolvedValue(null);
    await expect(b.service.request(admin, { tenantId: 't1', membershipId: 'x', reason: 'reason' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(b.service.request(admin, { tenantId: 't1', reason: 'reason' })).rejects.toMatchObject({ response: { i18n: 'support.noAdmin' } });

    const c = setup();
    c.prisma.membership.findFirst.mockResolvedValue({ ...ownerMember, status: 'BLOCKED' });
    await expect(c.service.request(admin, { tenantId: 't1', reason: 'reason' })).rejects.toMatchObject({ response: { i18n: 'support.memberBlocked' } });

    const d = setup();
    d.prisma.tenant.findUnique.mockResolvedValue({ id: 't1', name: 'Center', status: 'SUSPENDED' });
    await expect(d.service.request(admin, { tenantId: 't1', reason: 'reason' })).rejects.toMatchObject({ response: { i18n: 'support.tenantSuspended' } });
    expect(d.prisma.supportRequest.create).not.toHaveBeenCalled();
  });
});

describe('SupportService.start (platform)', () => {
  const approved = (over: object = {}) =>
    request({ status: 'APPROVED', accessUntil: hours(4), tenant: { status: 'ACTIVE' }, membership: { id: 'm1', status: 'ACTIVE', userId: 'u1' }, ...over });

  it('enters only under an approved request, as its member, for its minutes', async () => {
    const { prisma, auth, service } = setup();
    prisma.supportRequest.findUnique.mockResolvedValue(approved());
    const before = Date.now();
    await service.start(admin, 'r1');
    const data = prisma.supportSession.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ actorId: 'admin', tenantId: 't1', membershipId: 'm1', requestId: 'r1', reason: 'Schedule not saving' });
    expect(data.expiresAt.getTime() - before).toBeGreaterThanOrEqual(60 * 60_000 - 1000);
    expect(auth.issueSupportTokens).toHaveBeenCalledWith('u1', 'm1', 's1');
  });

  it('never outlives the approval', async () => {
    const { prisma, service } = setup();
    const until = hours(0.25);
    prisma.supportRequest.findUnique.mockResolvedValue(approved({ accessUntil: until }));
    await service.start(admin, 'r1');
    expect(prisma.supportSession.create.mock.calls[0][0].data.expiresAt).toEqual(until);
  });

  it('refuses requests that are pending, denied, revoked, canceled or past their window', async () => {
    for (const over of [{ status: 'PENDING', accessUntil: null }, { status: 'DENIED' }, { status: 'REVOKED' }, { status: 'CANCELED' }, { accessUntil: hours(-1) }]) {
      const { prisma, auth, service } = setup();
      prisma.supportRequest.findUnique.mockResolvedValue(approved(over));
      await expect(service.start(admin, 'r1')).rejects.toMatchObject({ response: { i18n: 'support.notApproved' } });
      expect(auth.issueSupportTokens).not.toHaveBeenCalled();
    }
  });

  it('refuses when the member was blocked or removed since', async () => {
    const a = setup();
    a.prisma.supportRequest.findUnique.mockResolvedValue(approved({ membership: { id: 'm1', status: 'BLOCKED', userId: 'u1' } }));
    await expect(a.service.start(admin, 'r1')).rejects.toBeInstanceOf(BadRequestException);
    const b = setup();
    b.prisma.supportRequest.findUnique.mockResolvedValue(approved({ membership: null }));
    await expect(b.service.start(admin, 'r1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SupportService center decisions', () => {
  it("approves a pending request of the admin's own center for the chosen hours", async () => {
    const { prisma, service } = setup();
    const res = await service.approve(owner, 'r1', 4);
    expect(prisma.supportRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r1', tenantId: 't1' } }));
    const data = prisma.supportRequest.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'APPROVED', decidedById: 'u1' });
    expect(data.accessUntil.getTime() - data.decidedAt.getTime()).toBe(4 * 3_600_000);
    expect(res.state).toBe('APPROVED');
  });

  it("can't decide another center's request, or one already decided or expired", async () => {
    const a = setup();
    a.prisma.supportRequest.findFirst.mockResolvedValue(null);
    await expect(a.service.approve(owner, 'r1', 1)).rejects.toBeInstanceOf(NotFoundException);
    for (const over of [{ status: 'DENIED' }, { status: 'APPROVED', accessUntil: hours(2) }, { createdAt: hours(-80) }]) {
      const b = setup();
      b.prisma.supportRequest.findFirst.mockResolvedValue(request(over));
      await expect(b.service.deny(owner, 'r1')).rejects.toBeInstanceOf(ConflictException);
      expect(b.prisma.supportRequest.update).not.toHaveBeenCalled();
    }
  });

  it('revokes an open approval and signs support out of the center at once', async () => {
    const { prisma, service } = setup();
    prisma.supportRequest.findFirst.mockResolvedValue(request({ status: 'APPROVED', accessUntil: hours(3) }));
    await service.revoke(owner, 'r1');
    expect(prisma.supportRequest.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'REVOKED' } }));
    expect(prisma.supportSession.findMany).toHaveBeenCalledWith({ where: { requestId: 'r1', endedAt: null }, select: { id: true } });
    expect(prisma.supportSession.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['s1'] }, endedAt: null }, data: { endedAt: expect.any(Date) } });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { supportSessionId: { in: ['s1'] }, revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  });

  it('keeps the action log of a session to its own center', async () => {
    const { prisma, service } = setup();
    Object.assign(prisma.supportSession, { findFirst: vi.fn().mockResolvedValue(null) });
    await expect(service.actions('s9', 't1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SupportService.end', () => {
  it('needs an open support session to leave one', async () => {
    const { service } = setup();
    await expect(service.endCurrent(admin)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('closes the current session and revokes its tokens', async () => {
    const { prisma, service } = setup();
    await service.endCurrent({ ...admin, supportSessionId: 's1' });
    expect(prisma.supportSession.findMany).toHaveBeenCalledWith({ where: { id: 's1', endedAt: null }, select: { id: true } });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalled();
  });
});

describe('SupportGuard', () => {
  const ctx = (user: Partial<JwtUser>) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user }) }), getHandler: () => null, getClass: () => null }) as unknown as ExecutionContext;
  const guard = (denied: boolean) => new SupportGuard({ getAllAndOverride: () => denied } as unknown as Reflector);

  it('lets normal sessions through every route', () => {
    expect(guard(true).canActivate(ctx(admin))).toBe(true);
  });

  it("stops support mode at the person's own account routes and the center's approvals", () => {
    const support = { ...owner, supportSessionId: 's1' };
    expect(guard(false).canActivate(ctx(support))).toBe(true);
    expect(() => guard(true).canActivate(ctx(support))).toThrow(ForbiddenException);
  });
});
