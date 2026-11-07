import { ConflictException, ForbiddenException } from '@nestjs/common';
import { vi } from 'vitest';
import { CoursesService, canChangeTeacher } from './courses.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const admin: JwtUser = {
  id: 'u1', email: 'owner@x.test', role: 'TENANT_ADMIN', tenantId: 't1', teacherId: null, studentId: null, status: 'ACTIVE', membershipId: 'm1',
};
const nothingTaught = { sessions: 0, exams: 0, schedules: 0 };

function setup(counts = nothingTaught) {
  const course = { id: 'c1', tenantId: 't1', teacherId: 'tc1', title: 'Algebra' };
  const prisma = {
    course: {
      findFirst: vi.fn().mockResolvedValue(course),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ _count: counts }),
      update: vi.fn().mockResolvedValue(course),
    },
    teacher: { findFirst: vi.fn().mockResolvedValue({ id: 'tc2', membershipId: 'm-tc2' }) },
    enrollment: { findMany: vi.fn().mockResolvedValue([{ studentId: 's1' }, { studentId: 's2' }]) },
    teacherStudent: { createMany: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const messaging = { courseTeacherChanged: vi.fn() };
  const prices = { coursePrices: vi.fn().mockResolvedValue(new Map()), setCoursePrice: vi.fn() };
  return { prisma, messaging, service: new CoursesService(prisma as unknown as PrismaService, messaging as never, prices as never) };
}

describe('CoursesService.update: another teacher', () => {
  it('hands a course nothing was taught in to another teacher, who gets its students and its groups', async () => {
    const { prisma, messaging, service } = setup();
    await service.update(admin, 'c1', { teacherId: 'tc2' });
    expect(prisma.teacherStudent.createMany).toHaveBeenCalledWith({
      data: [{ teacherId: 'tc2', studentId: 's1' }, { teacherId: 'tc2', studentId: 's2' }],
      skipDuplicates: true,
    });
    expect(prisma.course.update).toHaveBeenCalledWith(expect.objectContaining({ data: { teacherId: 'tc2' } }));
    expect(messaging.courseTeacherChanged).toHaveBeenCalledWith('c1', 'm-tc2');
  });

  it('keeps the teacher of a course with sessions, exams or schedules', async () => {
    for (const key of Object.keys(nothingTaught)) {
      const { prisma, service } = setup({ ...nothingTaught, [key]: 1 });
      await expect(service.update(admin, 'c1', { teacherId: 'tc2' })).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.course.update).not.toHaveBeenCalled();
    }
    expect(canChangeTeacher(nothingTaught)).toBe(true);
  });

  it("is the admin's call, and the same teacher sent back is no change", async () => {
    const teacher = setup();
    await expect(teacher.service.update({ ...admin, role: 'TEACHER', teacherId: 'tc1' }, 'c1', { teacherId: 'tc2' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const same = setup();
    await same.service.update({ ...admin, role: 'TEACHER', teacherId: 'tc1' }, 'c1', { teacherId: 'tc1', title: 'Algebra I' });
    expect(same.prisma.course.update).toHaveBeenCalledWith(expect.objectContaining({ data: { title: 'Algebra I' } }));
  });
});
