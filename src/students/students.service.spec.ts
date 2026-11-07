import { ConflictException, ForbiddenException } from '@nestjs/common';
import { vi } from 'vitest';
import { StudentsService, hasStudyRecord } from './students.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthService } from '../auth/auth.service.js';

const admin: JwtUser = {
  id: 'u1', email: 'owner@x.test', role: 'TENANT_ADMIN', tenantId: 't1', teacherId: null, studentId: null, status: 'ACTIVE', membershipId: 'm1',
};
const noRecord = { enrollments: 0, attendances: 0, examResults: 0, schedules: 0, billingRates: 0 };

function setup(count = noRecord, otherCenters = 0) {
  const row = {
    id: 's1',
    userId: 'u-s1',
    membershipId: 'ms1',
    user: { id: 'u-s1', email: 'sara@x.test', fullName: 'Sara', phone: null, isPlatformAdmin: false, _count: { memberships: 1 + otherCenters } },
    membership: { role: 'STUDENT', status: 'ACTIVE' },
    teachers: [{ teacher: { id: 'tc1' } }],
    _count: count,
  };
  const prisma = {
    student: {
      findFirst: vi.fn().mockResolvedValue(row),
      update: vi.fn().mockResolvedValue(row),
    },
    teacher: { count: vi.fn().mockImplementation(({ where }) => Promise.resolve(where.id.in.filter((id: string) => id.startsWith('tc')).length)) },
    teacherStudent: { createMany: vi.fn(), deleteMany: vi.fn() },
    passwordResetToken: { updateMany: vi.fn() },
    $transaction: vi.fn(),
    membership: {
      update: vi.fn(),
      delete: vi.fn(),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ userId: 'u-s1', user: { isPlatformAdmin: false, _count: { memberships: 1 + otherCenters } } }),
    },
    user: { delete: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
    refreshToken: { updateMany: vi.fn(), count: vi.fn().mockResolvedValue(1) },
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const events = { accountStatus: vi.fn(), memberRemoved: vi.fn(), teacherLinked: vi.fn(), memberAdded: vi.fn() };
  return { prisma, events, service: new StudentsService(prisma as unknown as PrismaService, { sendWelcome: vi.fn() } as unknown as AuthService, events as never) };
}

describe('hasStudyRecord', () => {
  it('is any session, grade, schedule, rate or enrollment', () => {
    expect(hasStudyRecord(noRecord)).toBe(false);
    for (const key of Object.keys(noRecord) as (keyof typeof noRecord)[]) {
      expect(hasStudyRecord({ ...noRecord, [key]: 1 })).toBe(true);
    }
  });
});

describe('StudentsService.setStatus', () => {
  const teacher: JwtUser = { ...admin, id: 'u-tc', role: 'TEACHER', teacherId: 'tc1' };

  it("lets a teacher suspend their own student in this center, but not someone else's", async () => {
    const { prisma, events, service } = setup();
    await service.setStatus(teacher, 's1', { status: 'SUSPENDED', reason: 'Missed 3 sessions' });
    expect(events.accountStatus).toHaveBeenCalledWith('ms1', 'SUSPENDED', 'Missed 3 sessions', 'u-tc');
    expect(prisma.membership.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ms1' }, data: expect.objectContaining({ status: 'SUSPENDED', statusChangedById: 'u-tc' }) }),
    );
    await expect(service.setStatus({ ...teacher, teacherId: 'tc2' }, 's1', { status: 'BLOCKED' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('StudentsService.remove', () => {
  it('removes a student nothing was recorded for, and their sign-in when it belongs to no other center', async () => {
    const { prisma, service } = setup();
    await service.remove(admin, 's1');
    expect(prisma.membership.delete).toHaveBeenCalledWith({ where: { id: 'ms1' } });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u-s1' } });
  });

  it('keeps the sign-in of a student who also belongs to another center', async () => {
    const { prisma, service } = setup(noRecord, 1);
    await service.remove(admin, 's1');
    expect(prisma.membership.delete).toHaveBeenCalled();
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('keeps a student who attended a session (suspend them instead)', async () => {
    const { prisma, service } = setup({ ...noRecord, attendances: 3 });
    await expect(service.remove(admin, 's1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.membership.delete).not.toHaveBeenCalled();
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });
});

describe('StudentsService.update', () => {
  const teacher: JwtUser = { ...admin, id: 'u-tc', role: 'TEACHER', teacherId: 'tc1' };

  it("replaces the student's teachers with the ones the admin chose, and tells the new ones", async () => {
    const { prisma, events, service } = setup();
    await service.update(admin, 's1', { teacherIds: ['tc2', 'tc3'] });
    expect(prisma.teacherStudent.deleteMany).toHaveBeenCalledWith({ where: { studentId: 's1', teacherId: { in: ['tc1'] } } });
    expect(prisma.teacherStudent.createMany).toHaveBeenCalledWith({
      data: [{ teacherId: 'tc2', studentId: 's1' }, { teacherId: 'tc3', studentId: 's1' }],
      skipDuplicates: true,
    });
    expect(events.teacherLinked).toHaveBeenCalledTimes(2);
  });

  it('refuses a teacher from outside the center', async () => {
    const { prisma, service } = setup();
    await expect(service.update(admin, 's1', { teacherIds: ['elsewhere'] })).rejects.toThrow();
    expect(prisma.student.update).not.toHaveBeenCalled();
  });

  it("leaves the teachers alone when a teacher edits (that is the center's call)", async () => {
    const { prisma, service } = setup();
    await service.update(teacher, 's1', { teacherIds: [], grade: '5' });
    expect(prisma.teacherStudent.deleteMany).not.toHaveBeenCalled();
    expect(prisma.student.update).toHaveBeenCalled();
  });

  it("lets the student's teacher fix the email of an account that is only in this center", async () => {
    const { prisma, service } = setup();
    await service.update(teacher, 's1', { email: 'sara2@x.test' });
    expect(prisma.student.update.mock.calls[0][0].data.user.update.email).toBe('sara2@x.test');
  });

  it('refuses a new password for an account that is in another center too', async () => {
    const { prisma, service } = setup(noRecord, 1);
    await expect(service.update(admin, 's1', { password: 'Strong#Pass1' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.student.update).not.toHaveBeenCalled();
  });
});
