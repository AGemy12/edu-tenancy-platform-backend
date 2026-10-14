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
  const prisma = {
    student: {
      findFirst: vi.fn().mockResolvedValue({ id: 's1', userId: 'u-s1', membershipId: 'ms1', teachers: [{ teacher: { id: 'tc1' } }], _count: count }),
    },
    membership: {
      update: vi.fn(),
      delete: vi.fn(),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ userId: 'u-s1', user: { isPlatformAdmin: false, _count: { memberships: 1 + otherCenters } } }),
    },
    user: { delete: vi.fn() },
    refreshToken: { updateMany: vi.fn() },
  };
  return { prisma, service: new StudentsService(prisma as unknown as PrismaService, {} as AuthService) };
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
    const { prisma, service } = setup();
    await service.setStatus(teacher, 's1', { status: 'SUSPENDED', reason: 'Missed 3 sessions' });
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
