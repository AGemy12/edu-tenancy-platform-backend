import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { AuthService } from './auth.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const PASSWORD = 'Password123!';
const passwordHash = bcrypt.hashSync(PASSWORD, 4);
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

const me: JwtUser = { id: 'u1', email: 'me@x.test', role: 'TEACHER', status: 'ACTIVE', tenantId: 't1', teacherId: 'tc1', studentId: null, membershipId: 'm1' };

const tenant = (id: string, status = 'ACTIVE') => ({ id, name: `Center ${id}`, slug: id, status });
const membership = (id: string, role: string, over: object = {}) => ({ id, role, status: 'ACTIVE', statusReason: null, tenant: tenant(`t-${id}`), ...over });

/** A user row as `userSelect` returns it. */
function account(over: object = {}) {
  return {
    id: 'u1',
    email: 'me@x.test',
    fullName: 'Me',
    phone: null,
    isPlatformAdmin: false,
    lastMembershipId: null,
    memberships: [membership('m1', 'TEACHER')],
    passwordHash,
    ...over,
  };
}

function setup({ emailTaken = false, user = account() }: { emailTaken?: boolean; user?: object } = {}) {
  const prisma = {
    user: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ ...user, email: 'me@x.test', passwordHash }),
      findUnique: vi.fn().mockImplementation(({ where }) =>
        Promise.resolve(where.email ? (emailTaken ? { id: 'u2' } : where.email === 'me@x.test' ? user : null) : user),
      ),
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...user, ...data })),
    },
    refreshToken: { updateMany: vi.fn(), create: vi.fn(), findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
    tenant: { findUnique: vi.fn().mockResolvedValue(null) },
    membership: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn().mockResolvedValue([]),
  };
  const jwt = { signAsync: vi.fn().mockImplementation((payload) => Promise.resolve(`jwt:${payload.sub}:${payload.mid}`)) };
  const config = { getOrThrow: () => 'secret', get: () => undefined };
  const service = new AuthService(prisma as unknown as PrismaService, jwt as never, config as never, {} as never);
  return { prisma, service };
}

describe('AuthService.login', () => {
  const login = (user: object) => setup({ user }).service.login({ email: 'me@x.test', password: PASSWORD });

  it('signs into the only center, and says so', async () => {
    const res = await login(account());
    expect(res.accessToken).toBe('jwt:u1:m1');
    expect(res.user).toMatchObject({ role: 'TEACHER', tenantId: 't-m1', membershipId: 'm1', memberships: [expect.objectContaining({ id: 'm1', usable: true })] });
  });

  it('lands in the center opened last, else the first usable one', async () => {
    const two = [membership('m1', 'TEACHER'), membership('m2', 'TENANT_ADMIN')];
    const remembered = await login(account({ memberships: two, lastMembershipId: 'm2' }));
    expect(remembered.accessToken).toBe('jwt:u1:m2');

    const fresh = await login(account({ memberships: two }));
    expect(fresh.accessToken).toBe('jwt:u1:m1');
  });

  it('skips centers where the user is blocked or that are suspended, and refuses when none is left', async () => {
    const blockedHere = account({ memberships: [membership('m1', 'TEACHER', { status: 'BLOCKED' }), membership('m2', 'STUDENT')] });
    expect((await login(blockedHere)).accessToken).toBe('jwt:u1:m2');

    const onlyBlocked = account({ memberships: [membership('m1', 'TEACHER', { status: 'BLOCKED' })] });
    await expect(login(onlyBlocked)).rejects.toMatchObject({ response: { i18n: 'auth.blocked' } });

    const centerDown = account({ memberships: [membership('m1', 'TEACHER', { tenant: tenant('t1', 'SUSPENDED') })] });
    await expect(login(centerDown)).rejects.toMatchObject({ response: { i18n: 'auth.tenantSuspended' } });

    await expect(login(account({ memberships: [] }))).rejects.toMatchObject({ response: { i18n: 'auth.noCenter' } });
  });

  it('sends the platform operator to the console when they have no centers', async () => {
    const res = await login(account({ isPlatformAdmin: true, memberships: [] }));
    expect(res.accessToken).toBe('jwt:u1:null');
    expect(res.user.role).toBe('SUPER_ADMIN');
  });

  it('rejects a wrong password', async () => {
    await expect(setup().service.login({ email: 'me@x.test', password: 'nope' })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthService.switch', () => {
  it('moves the session to another of the user\'s centers and remembers it', async () => {
    const { prisma, service } = setup({ user: account({ memberships: [membership('m1', 'TEACHER'), membership('m2', 'STUDENT')] }) });
    const res = await service.switch(me, { membershipId: 'm2' });
    expect(res.accessToken).toBe('jwt:u1:m2');
    expect(res.user).toMatchObject({ role: 'STUDENT', membershipId: 'm2' });
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { lastMembershipId: 'm2' } }));
  });

  it("refuses a center that isn't theirs, a blocked one, and the console for non-operators", async () => {
    const { service } = setup({ user: account({ memberships: [membership('m1', 'TEACHER'), membership('m3', 'STUDENT', { status: 'BLOCKED' })] }) });
    await expect(service.switch(me, { membershipId: 'm2' })).rejects.toThrow();
    await expect(service.switch(me, { membershipId: 'm3' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.switch(me, { membershipId: null })).rejects.toThrow();
  });
});

describe('AuthService.createTenant', () => {
  const owned = (status: string, daysLeft: number) => ({ tenant: { subscription: { status, currentPeriodEnd: new Date(Date.now() + daysLeft * 86_400_000) } } });
  const dto = { tenantName: 'Second', tenantSlug: 'second' };

  it('stops at the owned-centers limit', async () => {
    const { prisma, service } = setup();
    prisma.membership.findMany.mockResolvedValue([owned('ACTIVE', 30), owned('ACTIVE', 30), owned('ACTIVE', 30)]);
    await expect(service.createTenant(me, dto)).rejects.toMatchObject({ response: { i18n: 'auth.tooManyCenters', params: { max: 3 } } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('allows one running trial at a time; an expired trial does not block', async () => {
    const running = setup();
    running.prisma.membership.findMany.mockResolvedValue([owned('TRIALING', 5)]);
    await expect(running.service.createTenant(me, dto)).rejects.toMatchObject({ response: { i18n: 'auth.trialInProgress' } });

    const expired = setup();
    expired.prisma.membership.findMany.mockResolvedValue([owned('TRIALING', -1), owned('ACTIVE', 30)]);
    expired.prisma.$transaction.mockResolvedValue({ id: 'm1' });
    await expect(expired.service.createTenant(me, dto)).resolves.toMatchObject({ accessToken: 'jwt:u1:m1' });
  });
});

describe('AuthService.updateProfile', () => {
  it('updates name and phone without a password', async () => {
    const { prisma, service } = setup();
    await service.updateProfile(me, { fullName: '  New Name ', phone: '' });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u1' }, data: { fullName: 'New Name', phone: null } }),
    );
  });

  it('ignores an unchanged email', async () => {
    const { prisma, service } = setup();
    await service.updateProfile(me, { email: 'ME@x.test' });
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: {} }));
  });

  it('needs the current password to change the email', async () => {
    const { prisma, service } = setup();
    await expect(service.updateProfile(me, { email: 'new@x.test' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateProfile(me, { email: 'new@x.test', currentPassword: 'wrong' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses an email another account uses', async () => {
    const { prisma, service } = setup({ emailTaken: true });
    await expect(service.updateProfile(me, { email: 'new@x.test', currentPassword: PASSWORD })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('changes the email with the right password', async () => {
    const { prisma, service } = setup();
    await service.updateProfile(me, { email: 'New@X.test', currentPassword: PASSWORD });
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { email: 'new@x.test' } }));
  });
});

describe('AuthService.changePassword', () => {
  it('rejects a wrong current password', async () => {
    const { prisma, service } = setup();
    await expect(service.changePassword('u1', { currentPassword: 'wrong', newPassword: 'Another123!' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects reusing the same password', async () => {
    const { service } = setup();
    await expect(service.changePassword('u1', { currentPassword: PASSWORD, newPassword: PASSWORD })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('stores a new hash and signs out every other session', async () => {
    const { prisma, service } = setup();
    await service.changePassword('u1', { currentPassword: PASSWORD, newPassword: 'Another123!', refreshToken: 'mine' });

    const { data } = prisma.user.update.mock.calls[0][0];
    expect(await bcrypt.compare('Another123!', data.passwordHash)).toBe(true);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', revokedAt: null, tokenHash: { not: sha256('mine') } },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
