import { ConflictException, ForbiddenException } from '@nestjs/common';
import { vi } from 'vitest';
import { TeachersService, hasTeachingRecord } from './teachers.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthService } from '../auth/auth.service.js';

const admin: JwtUser = {
  id: 'u1', email: 'owner@x.test', role: 'TENANT_ADMIN', tenantId: 't1', teacherId: null, studentId: null, status: 'ACTIVE', membershipId: 'm1',
};
const noRecord = { courses: 0, students: 0, sessions: 0, exams: 0, schedules: 0, billingRates: 0 };

function setup({
  maxTeachers = 3,
  teachers = 0,
  row,
  existingUser = null,
  otherCenters = 0,
}: { maxTeachers?: number; teachers?: number; row?: object; existingUser?: object | null; otherCenters?: number } = {}) {
  const prisma = {
    subscription: { findUnique: vi.fn().mockResolvedValue({ plan: { maxTeachers } }) },
    teacher: {
      count: vi.fn().mockResolvedValue(teachers),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'tc9', ...data })),
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
    refreshToken: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const auth = { sendWelcome: vi.fn() };
  return { prisma, auth, service: new TeachersService(prisma as unknown as PrismaService, auth as unknown as AuthService) };
}

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
  const row = { id: 'tc1', userId: 'u1', membershipId: 'm1', membership: { id: 'm1', role: 'TENANT_ADMIN' }, _count: noRecord };
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
