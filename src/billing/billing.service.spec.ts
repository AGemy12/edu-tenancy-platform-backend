import { BadRequestException, ConflictException } from '@nestjs/common';
import { vi } from 'vitest';
import { BillingService } from './billing.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const base = { id: 'u', email: 'x@test', tenantId: 't1', teacherId: null, studentId: null, status: 'ACTIVE' as const, membershipId: 'm1' };
const admin: JwtUser = { ...base, id: 'u-admin', role: 'TENANT_ADMIN' };
const teacher: JwtUser = { ...base, id: 'u-tc', role: 'TEACHER', teacherId: 'tc1' };
const student: JwtUser = { ...base, id: 'u-st', role: 'STUDENT', studentId: 's1' };

const range = { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' };
const decimal = (n: number) => n as unknown as never;

const attendee = (studentId: string, name: string, attended: boolean) => ({
  studentId,
  attended,
  joinedAt: attended ? new Date('2026-10-05T10:02:00Z') : null,
  student: { user: { fullName: name } },
});

/** One 90-minute completed session with two students; s1 joined, s2 didn't. */
const session = {
  id: 'ses1',
  title: 'Algebra',
  status: 'COMPLETED',
  provider: 'ZOOM',
  startAt: new Date('2026-10-05T10:00:00Z'),
  endAt: new Date('2026-10-05T11:30:00Z'),
  startedAt: new Date('2026-10-05T10:01:00Z') as Date | null,
  endedAt: new Date('2026-10-05T11:20:00Z'),
  teacherId: 'tc1',
  courseId: 'c1',
  teacher: { user: { fullName: 'Teacher' } },
  course: { id: 'c1', title: 'Math' },
  attendees: [attendee('s1', 'Sara', true), attendee('s2', 'Omar', false)],
};

const rates = [
  { id: 'r1', kind: 'STUDENT_FEE', basis: 'PER_HOUR', teacherId: 'tc1', courseId: null, studentId: null, amount: decimal(100), effectiveFrom: new Date('2026-01-01') },
  { id: 'r2', kind: 'STUDENT_FEE', basis: 'PER_HOUR', teacherId: 'tc1', courseId: null, studentId: 's2', amount: decimal(80), effectiveFrom: new Date('2026-01-01') },
  { id: 'r3', kind: 'TEACHER_PAY', basis: 'PERCENT', teacherId: 'tc1', courseId: null, studentId: null, amount: decimal(50), effectiveFrom: new Date('2026-01-01') },
];

function setup(sessions = [session]) {
  const prisma = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ currency: 'EGP', timezone: 'Africa/Cairo' }) },
    session: { findMany: vi.fn().mockResolvedValue(sessions) },
    billingRate: {
      findMany: vi.fn().mockResolvedValue(rates),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: 'new', ...data, teacher: { id: data.teacherId, user: { fullName: 'T' } }, course: null, student: null }),
      ),
    },
    teacher: { findFirst: vi.fn().mockResolvedValue({ id: 'tc1' }) },
    course: { findFirst: vi.fn().mockResolvedValue({ id: 'c1' }) },
    student: { findFirst: vi.fn().mockResolvedValue({ id: 's1' }) },
  };
  return { prisma, service: new BillingService(prisma as unknown as PrismaService) };
}

describe('BillingService.sessions', () => {
  it('charges every student on a held session, present or not', async () => {
    const { service } = setup();
    const res = await service.sessions(admin, range);
    const row = res.rows[0];
    expect(row.minutes).toBe(90);
    expect(row.actualMinutes).toBe(79);
    // Sara: default 100/h × 1.5h; Omar: his own 80/h × 1.5h, though he didn't join.
    expect(row.students.map((s) => [s.name, s.fee, s.rateSource])).toEqual([
      ['Sara', 150, 'TEACHER'],
      ['Omar', 120, 'STUDENT'],
    ]);
    expect(row.fees).toBe(270);
    expect(row.teacherPay).toEqual({ amount: 135, basis: 'PERCENT', rate: 50, source: 'TEACHER' });
    expect(row.net).toBe(135);
    expect(res.totals).toMatchObject({ sessions: 1, minutes: 90, studentMinutes: 180, fees: 270, teacherPay: 135, net: 135 });
  });

  it('defaults to charged statuses and scopes a teacher to their own sessions', async () => {
    const { prisma, service } = setup();
    await service.sessions(teacher, { ...range, teacherId: 'someone-else' });
    const where = prisma.session.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: 't1', teacherId: 'tc1', status: { in: ['LIVE', 'COMPLETED'] } });
  });

  it('shows a teacher their pay but not the center net', async () => {
    const { service } = setup();
    const res = await service.sessions(teacher, range);
    expect(res.rows[0].teacherPay).toBeTruthy();
    expect(res.rows[0]).not.toHaveProperty('net');
    expect(res.totals).not.toHaveProperty('net');
  });

  it('shows a student only their own line, without teacher pay', async () => {
    const { prisma, service } = setup();
    const res = await service.sessions(student, { ...range, studentId: 's2' });
    const where = prisma.session.findMany.mock.calls[0][0].where;
    expect(where.attendees).toEqual({ some: { studentId: 's1' } });
    expect(res.rows[0].students.map((s) => s.name)).toEqual(['Sara']);
    expect(res.rows[0].fees).toBe(150);
    expect(res.rows[0]).not.toHaveProperty('teacherPay');
    expect(res.totals).not.toHaveProperty('teacherPay');
  });

  it("keeps the teacher's share on the whole session when one student is filtered", async () => {
    const { service } = setup();
    const res = await service.sessions(admin, { ...range, studentId: 's1' });
    expect(res.rows[0].fees).toBe(150);
    expect(res.rows[0].teacherPay?.amount).toBe(135);
    expect(res.rows[0]).not.toHaveProperty('net');
  });

  it('filters by attendance and missing prices', async () => {
    const { service } = setup();
    const absent = await service.sessions(admin, { ...range, attendance: 'absent' });
    expect(absent.rows[0].students.map((s) => s.name)).toEqual(['Omar']);
    const missing = await service.sessions(admin, { ...range, missingRate: true });
    expect(missing.rows).toHaveLength(0);
  });

  it('charges nothing for a canceled session the viewer asked to see', async () => {
    const { service } = setup([{ ...session, status: 'CANCELED', startedAt: null }]);
    const res = await service.sessions(admin, { ...range, status: ['CANCELED'] });
    expect(res.rows[0]).toMatchObject({ billable: false, minutes: 0, fees: 0, teacherPay: null });
  });

  it('refuses empty or over-long ranges', async () => {
    const { service } = setup();
    await expect(service.sessions(admin, { from: range.to, to: range.from })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.sessions(admin, { from: '2025-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('BillingService.summary', () => {
  it('groups student time and fees per student', async () => {
    const { service } = setup();
    const res = await service.summary(admin, { ...range, groupBy: 'student' });
    expect(res.groups.map((g) => [g.label, g.minutes, g.fees])).toEqual([
      ['Sara', 90, 150],
      ['Omar', 90, 120],
    ]);
    expect(res.groups[0]).not.toHaveProperty('teacherPay');
  });

  it('groups by month in the center time zone', async () => {
    const { service } = setup();
    const res = await service.summary(admin, { ...range, groupBy: 'month' });
    expect(res.groups).toEqual([{ key: '2026-10', label: null, sessions: 1, minutes: 90, fees: 270, teacherPay: 135, net: 135 }]);
  });
});

describe('BillingService rates', () => {
  const dto = { kind: 'STUDENT_FEE' as const, teacherId: 'tc1', amount: 100, effectiveFrom: '2026-10-01T00:00:00Z' };

  it('rejects percentages for student fees and student-specific teacher pay', async () => {
    const { service } = setup();
    await expect(service.createRate(admin, { ...dto, basis: 'PERCENT' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createRate(admin, { ...dto, kind: 'TEACHER_PAY', basis: 'PERCENT', amount: 120 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.createRate(admin, { ...dto, kind: 'TEACHER_PAY', studentId: 's1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a second price for the same scope and start date', async () => {
    const { prisma, service } = setup();
    prisma.billingRate.findFirst.mockResolvedValueOnce({ id: 'twin' });
    await expect(service.createRate(admin, dto)).rejects.toBeInstanceOf(ConflictException);
  });

  it('checks the course belongs to the teacher in this center', async () => {
    const { prisma, service } = setup();
    await service.createRate(admin, { ...dto, courseId: 'c1' });
    expect(prisma.course.findFirst).toHaveBeenCalledWith({ where: { id: 'c1', tenantId: 't1', teacherId: 'tc1' } });
    expect(prisma.billingRate.create.mock.calls[0][0].data).toMatchObject({ tenantId: 't1', courseId: 'c1', studentId: null, basis: 'PER_HOUR' });
  });
});
