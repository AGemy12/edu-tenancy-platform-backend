import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ReportsService } from './reports.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';

const q = { from: '2026-10-01', to: '2026-10-31' };

function setup() {
  const prisma = {
    tenant: { findUniqueOrThrow: vi.fn().mockResolvedValue({ name: 'Center', timezone: 'Africa/Cairo', currency: 'EGP', logoKey: null }) },
    student: { findFirst: vi.fn().mockResolvedValue(null) },
    sessionAttendee: { findMany: vi.fn().mockResolvedValue([]) },
    examResult: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { prisma, service: new ReportsService(prisma as never, {} as never) };
}

const student = { role: 'STUDENT', tenantId: 't1', studentId: 'me' } as JwtUser;
const teacher = { role: 'TEACHER', tenantId: 't1', teacherId: 'tch' } as JwtUser;

describe('ReportsService.student scoping', () => {
  it("never lets a student open another student's report", async () => {
    const { service, prisma } = setup();
    await expect(service.student(student, 'someone-else', q)).rejects.toBeInstanceOf(NotFoundException);
    const where = prisma.student.findFirst.mock.calls[0][0].where;
    // Both the requested id and the viewer's own scope must hold.
    expect(where).toEqual({ AND: [{ id: 'someone-else' }, { tenantId: 't1', id: 'me' }] });
    expect(prisma.sessionAttendee.findMany).not.toHaveBeenCalled();
  });

  it("limits a teacher to the students they teach, in their own center", async () => {
    const { service, prisma } = setup();
    await expect(service.student(teacher, 's1', q)).rejects.toBeInstanceOf(NotFoundException);
    const [, scope] = prisma.student.findFirst.mock.calls[0][0].where.AND;
    expect(scope.tenantId).toBe('t1');
    expect(scope.OR).toEqual(
      expect.arrayContaining([{ teachers: { some: { teacherId: 'tch' } } }, { enrollments: { some: { course: { teacherId: 'tch' } } } }]),
    );
  });

  it('refuses impossible or reversed periods before touching data', async () => {
    const { service, prisma } = setup();
    await expect(service.student(student, 'me', { from: '2026-02-30', to: '2026-03-02' })).rejects.toMatchObject({ response: { i18n: 'reports.invalidDate' } });
    await expect(service.student(student, 'me', { from: '2026-10-31', to: '2026-10-01' })).rejects.toMatchObject({ response: { i18n: 'reports.invalidRange' } });
    expect(prisma.student.findFirst).not.toHaveBeenCalled();
  });
});
