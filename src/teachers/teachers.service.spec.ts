import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { vi } from 'vitest';
import { TeachersService, hasTeachingRecord } from './teachers.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthService } from '../auth/auth.service.js';

const admin: JwtUser = {
  id: 'u1', email: 'owner@x.test', role: 'TENANT_ADMIN', tenantId: 't1', teacherId: null, studentId: null, status: 'ACTIVE', membershipId: 'm1',
};
const noRecord = { courses: 0, students: 0, sessions: 0, exams: 0, schedules: 0, billingRates: 0 };
/** What the teacher include selects about the account. */
const account = (userId: string, centers = 1) => ({ id: userId, email: `${userId}@x.test`, fullName: 'T', phone: null, isPlatformAdmin: false, _count: { memberships: centers } });

function setup({
  maxTeachers = 3,
  teachers = 0,
  row,
  existingUser = null,
  otherCenters = 0,
  integrations = [],
}: { maxTeachers?: number; teachers?: number; row?: object; existingUser?: object | null; otherCenters?: number; integrations?: { userId: string; provider: string }[] } = {}) {
  const prisma = {
    integration: {
      findMany: vi.fn().mockResolvedValue(integrations),
      count: vi.fn().mockImplementation(({ where }) =>
        Promise.resolve(integrations.filter((i) => i.userId === where.userId && i.provider === where.provider).length),
      ),
    },
    subscription: { findUnique: vi.fn().mockResolvedValue({ plan: { maxTeachers } }) },
    teacher: {
      count: vi.fn().mockResolvedValue(teachers),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'tc9', ...data, user: account(data.userId), membership: { role: 'TEACHER' } })),
      findFirst: vi.fn().mockResolvedValue(row ?? null),
      update: vi.fn().mockResolvedValue(row),
      delete: vi.fn().mockResolvedValue(row),
    },
    membership: {
      create: vi.fn().mockResolvedValue({ id: 'm9' }),
      update: vi.fn(),
      delete: vi.fn(),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ userId: 'u1', user: { isPlatformAdmin: false, _count: { memberships: 1 + otherCenters } } }),
    },
    user: {
      create: vi.fn().mockResolvedValue({ id: 'u9' }),
      delete: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(existingUser),
    },
    refreshToken: { updateMany: vi.fn(), count: vi.fn().mockResolvedValue(1) },
    passwordResetToken: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const auth = { sendWelcome: vi.fn() };
  const events = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, { get: (fns, k: string) => (fns[k] ??= vi.fn()) });
  const prices = { teacherPays: vi.fn().mockResolvedValue(new Map([['tc1', { basis: 'PER_SESSION', amount: 90 }]])), setTeacherPay: vi.fn() };
  return { prisma, auth, events, prices, service: new TeachersService(prisma as unknown as PrismaService, auth as unknown as AuthService, events as never, prices as never) };
}

describe('teachers and their meeting accounts', () => {
  const rows = [
    { id: 'tc1', userId: 'u2', membershipId: 'm2', user: account('u2'), membership: { role: 'TEACHER' } },
    { id: 'tc2', userId: 'u3', membershipId: 'm3', user: account('u3'), membership: { role: 'TEACHER' } },
  ];
  const integrations = [
    { userId: 'u2', provider: 'ZOOM' },
    { userId: 'u2', provider: 'GOOGLE' },
    { userId: 'u3', provider: 'GOOGLE' },
  ];

  it('shows the admin which accounts each teacher linked', async () => {
    const { prisma, service } = setup({ integrations });
    prisma.teacher.findMany.mockResolvedValue(rows);
    const list = await service.list(admin);
    expect(list.map((t) => (t as { meetingAccounts?: object }).meetingAccounts)).toEqual([
      { zoom: true, google: true },
      { zoom: false, google: true },
    ]);
  });

  it('tells teachers and students nothing about them, or about pay', async () => {
    for (const role of ['TEACHER', 'STUDENT'] as const) {
      const { prisma, prices, service } = setup({ integrations });
      prisma.teacher.findMany.mockResolvedValue(rows);
      const list = await service.list({ ...admin, role });
      expect(list.some((t) => 'meetingAccounts' in t || 'pay' in t)).toBe(false);
      expect(prisma.integration.findMany).not.toHaveBeenCalled();
      expect(prices.teacherPays).not.toHaveBeenCalled();
    }
  });

  it("shows the admin each teacher's pay per session", async () => {
    const { prisma, service } = setup({ integrations });
    prisma.teacher.findMany.mockResolvedValue(rows);
    const list = await service.list(admin);
    expect(list.map((t) => (t as { pay?: object | null }).pay)).toEqual([{ basis: 'PER_SESSION', amount: 90 }, null]);
  });

  it('saves the pay sent with the form, and leaves it alone when omitted', async () => {
    const { prices, service } = setup({ row: rows[0] });
    await service.update(admin, 'tc1', { fullName: 'X' });
    expect(prices.setTeacherPay).not.toHaveBeenCalled();
    await service.update(admin, 'tc1', { payBasis: 'PERCENT', payAmount: 50 });
    expect(prices.setTeacherPay).toHaveBeenLastCalledWith('t1', 'tc1', { basis: 'PERCENT', amount: 50 });
    await service.update(admin, 'tc1', { payAmount: null });
    expect(prices.setTeacherPay).toHaveBeenLastCalledWith('t1', 'tc1', null);
  });

  it('reminds a teacher to link an account they lack, and refuses one they already linked', async () => {
    const { events, service } = setup({ row: rows[1], integrations });
    await service.remindMeetingAccount(admin, 'tc2', 'ZOOM');
    expect(events.meetingAccountNeeded).toHaveBeenCalledWith('m3', 'ZOOM', 'u1');

    await expect(service.remindMeetingAccount(admin, 'tc2', 'GOOGLE_MEET')).rejects.toBeInstanceOf(ConflictException);
    expect(events.meetingAccountNeeded).toHaveBeenCalledTimes(1);
  });

  it('looks the teacher up inside the center', async () => {
    const { prisma, service } = setup();
    await expect(service.remindMeetingAccount(admin, 'elsewhere', 'ZOOM')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.teacher.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'elsewhere', tenantId: 't1' } }));
  });
});

describe('TeachersService.addSelf', () => {
  it('links a teacher profile to the admin account and membership', async () => {
    const { prisma, service } = setup();
    await service.addSelf(admin);
    expect(prisma.teacher.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { tenantId: 't1', userId: 'u1', membershipId: 'm1' } }),
    );
  });

  it('refuses when the admin already teaches', async () => {
    const { service } = setup();
    await expect(service.addSelf({ ...admin, teacherId: 'tc1' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('counts toward the plan teacher limit', async () => {
    const { prisma, service } = setup({ maxTeachers: 1, teachers: 1 });
    await expect(service.addSelf(admin)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.teacher.create).not.toHaveBeenCalled();
  });

  it('is only for tenant admins', async () => {
    const { service } = setup();
    await expect(service.addSelf({ ...admin, role: 'TEACHER' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.addSelf({ ...admin, role: 'SUPER_ADMIN', tenantId: null, membershipId: null })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe("the admin's own teacher row", () => {
  const row = { id: 'tc1', userId: 'u1', membershipId: 'm1', user: account('u1'), membership: { id: 'm1', role: 'TENANT_ADMIN' }, _count: noRecord };
  const regular = { ...row, membership: { id: 'm1', role: 'TEACHER' } };

  it('cannot be suspended or blocked', async () => {
    const { prisma, service } = setup({ row });
    await expect(service.setStatus(admin, 'tc1', { status: 'SUSPENDED' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.setStatus(admin, 'tc1', { status: 'BLOCKED' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.membership.update).not.toHaveBeenCalled();
  });

  it('is removed without touching the admin membership or account', async () => {
    const { prisma, service } = setup({ row });
    await service.remove('t1', 'tc1');
    expect(prisma.teacher.delete).toHaveBeenCalledWith({ where: { id: 'tc1' } });
    expect(prisma.membership.delete).not.toHaveBeenCalled();
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('a regular teacher can be suspended with a reason, and blocking signs them out of this center', async () => {
    const { prisma, service } = setup({ row: regular });
    await service.setStatus(admin, 'tc1', { status: 'SUSPENDED', reason: '  Unpaid dues  ' });
    expect(prisma.membership.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { status: 'SUSPENDED', statusReason: 'Unpaid dues', statusChangedAt: expect.any(Date), statusChangedById: 'u1' },
    });
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();

    await service.setStatus(admin, 'tc1', { status: 'BLOCKED' });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { membershipId: 'm1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });

    await service.setStatus(admin, 'tc1', { status: 'ACTIVE', reason: 'ignored' });
    expect(prisma.membership.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE', statusReason: null }) }));
  });

  it('removing a regular teacher drops their membership, and the sign-in only when it belongs to no other center', async () => {
    const alone = setup({ row: regular });
    await alone.service.remove('t1', 'tc1');
    expect(alone.prisma.membership.delete).toHaveBeenCalledWith({ where: { id: 'm1' } });
    expect(alone.prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });

    const elsewhere = setup({ row: regular, otherCenters: 1 });
    await elsewhere.service.remove('t1', 'tc1');
    expect(elsewhere.prisma.membership.delete).toHaveBeenCalledWith({ where: { id: 'm1' } });
    expect(elsewhere.prisma.user.delete).not.toHaveBeenCalled();
  });

  it('keeps a teacher who taught anything (suspend them instead), the admin too', async () => {
    for (const base of [regular, row]) {
      const { prisma, service } = setup({ row: { ...base, _count: { ...noRecord, sessions: 1 } } });
      await expect(service.remove('t1', 'tc1')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.membership.delete).not.toHaveBeenCalled();
      expect(prisma.teacher.delete).not.toHaveBeenCalled();
    }
    // Being linked to students is not a record.
    expect(hasTeachingRecord({ ...noRecord, students: 5 })).toBe(false);
    expect(hasTeachingRecord({ ...noRecord, courses: 1 })).toBe(true);
  });
});

describe('TeachersService.create', () => {
  it('creates the account, the membership and the profile, and sends the welcome email in the request language', async () => {
    const { prisma, auth, service } = setup();
    await service.create(admin, { fullName: 'Mona', email: 'Mona@X.test' }, 'en');
    const account = prisma.user.create.mock.calls[0][0].data;
    expect(account).toMatchObject({ email: 'mona@x.test', fullName: 'Mona' });
    expect(account.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(prisma.membership.create).toHaveBeenCalledWith(expect.objectContaining({ data: { userId: 'u9', tenantId: 't1', role: 'TEACHER' } }));
    expect(prisma.teacher.create.mock.calls[0][0].data).toMatchObject({ tenantId: 't1', userId: 'u9', membershipId: 'm9' });
    expect(auth.sendWelcome).toHaveBeenCalledWith('m9', { existingAccount: false }, 'en');
  });

  it('adds someone who already has an account (elsewhere) with that account, no new password', async () => {
    const { prisma, auth, service } = setup({ existingUser: { id: 'u7', memberships: [] } });
    await service.create(admin, { fullName: 'Mona', email: 'mona@x.test', password: 'Ignored#1a' });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.membership.create).toHaveBeenCalledWith(expect.objectContaining({ data: { userId: 'u7', tenantId: 't1', role: 'TEACHER' } }));
    expect(auth.sendWelcome).toHaveBeenCalledWith('m9', { existingAccount: true }, undefined);
  });

  it('refuses someone already in this center', async () => {
    const { prisma, service } = setup({ existingUser: { id: 'u7', memberships: [{ id: 'm7' }] } });
    await expect(service.create(admin, { fullName: 'Mona', email: 'mona@x.test' })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.membership.create).not.toHaveBeenCalled();
  });
});

describe('TeachersService.update: the sign-in email and password', () => {
  const teacher = { id: 'tc1', userId: 'u2', membershipId: 'm2', user: account('u2'), membership: { id: 'm2', role: 'TEACHER' }, _count: noRecord };
  const userData = (prisma: ReturnType<typeof setup>['prisma']) => prisma.teacher.update.mock.calls[0][0].data.user.update;

  it('changes them for a teacher whose account is only in this center, and signs them out everywhere on a new password', async () => {
    const { prisma, service } = setup({ row: teacher });
    await service.update(admin, 'tc1', { email: ' New@X.test ', password: 'Strong#Pass1' });
    expect(userData(prisma).email).toBe('new@x.test');
    expect(userData(prisma).passwordHash).toMatch(/^\$2[aby]\$/);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { userId: 'u2', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalled();
  });

  it('sends the welcome email again to a corrected address when the teacher never signed in', async () => {
    const { prisma, auth, service } = setup({ row: teacher });
    prisma.refreshToken.count.mockResolvedValue(0);
    await service.update(admin, 'tc1', { email: 'fixed@x.test' }, 'en');
    expect(auth.sendWelcome).toHaveBeenCalledWith('m2', { existingAccount: false }, 'en');
  });

  it('treats the email sent back unchanged as no change, even on an account it may not change', async () => {
    const { prisma, service } = setup({ row: { ...teacher, user: account('u2', 2) } });
    await service.update(admin, 'tc1', { email: 'u2@x.test', fullName: 'Mona' });
    expect(userData(prisma)).toEqual({ fullName: 'Mona', phone: undefined });
  });

  it('refuses an account that is in other centers too, or is the editor’s own', async () => {
    for (const row of [{ ...teacher, user: account('u2', 2) }, { ...teacher, userId: 'u1', user: account('u1') }]) {
      const { prisma, service } = setup({ row });
      await expect(service.update(admin, 'tc1', { password: 'Strong#Pass1' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.teacher.update).not.toHaveBeenCalled();
    }
  });

  it('refuses an email someone else signs in with', async () => {
    const { prisma, service } = setup({ row: teacher, existingUser: { id: 'u7' } });
    await expect(service.update(admin, 'tc1', { email: 'taken@x.test' })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.teacher.update).not.toHaveBeenCalled();
  });
});
