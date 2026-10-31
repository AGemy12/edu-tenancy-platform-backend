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

// The center's default price, one student's own price, and the teacher's share.
const rates = [
  { id: 'r1', kind: 'STUDENT_FEE', basis: 'PER_HOUR', teacherId: null, courseId: null, studentId: null, amount: decimal(100), effectiveFrom: new Date('2026-01-01') },
  { id: 'r2', kind: 'STUDENT_FEE', basis: 'PER_HOUR', teacherId: null, courseId: null, studentId: 's2', amount: decimal(80), effectiveFrom: new Date('2026-01-01') },
  { id: 'r3', kind: 'TEACHER_PAY', basis: 'PERCENT', teacherId: 'tc1', courseId: null, studentId: null, amount: decimal(50), effectiveFrom: new Date('2026-01-01') },
];

function setup(sessions = [session], platformFeePercent: number | null = null) {
  const prisma = {
    tenant: {
      findUnique: vi.fn().mockResolvedValue({ currency: 'EGP', timezone: 'Africa/Cairo', platformFeePercent: platformFeePercent === null ? null : decimal(platformFeePercent) }),
      findMany: vi.fn(),
    },
    session: { findMany: vi.fn().mockResolvedValue(sessions) },
    billingRate: {
      findMany: vi.fn().mockResolvedValue(rates),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'new',
          ...data,
          teacher: data.teacherId ? { id: data.teacherId, user: { fullName: 'T' } } : null,
          course: null,
          student: null,
        }),
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
    // Sara: the center's 100/h × 1.5h; Omar: his own 80/h × 1.5h, though he didn't join.
    expect(row.students.map((s) => [s.name, s.fee, s.rateSource])).toEqual([
      ['Sara', 150, 'CENTER'],
      ['Omar', 120, 'STUDENT'],
    ]);
    expect(row.fees).toBe(270);
    expect(row.teacherPay).toEqual({ amount: 135, basis: 'PERCENT', rate: 50, source: 'TEACHER' });
    expect(row.platformFee).toBe(0);
    expect(row.net).toBe(135);
    expect(res.platformFeePercent).toBeNull();
    expect(res.totals).toMatchObject({ sessions: 1, minutes: 90, studentMinutes: 180, fees: 270, teacherPay: 135, platformFee: 0, net: 135 });
  });

  it("takes the platform's commission out of the center's net, not the teacher's pay", async () => {
    const { service } = setup([session], 10);
    const res = await service.sessions(admin, range);
    expect(res.platformFeePercent).toBe(10);
    // 10% of 270 = 27; net = 270 − 135 − 27.
    expect(res.rows[0]).toMatchObject({ fees: 270, platformFee: 27, net: 108 });
    expect(res.rows[0].teacherPay?.amount).toBe(135);
    expect(res.totals).toMatchObject({ platformFee: 27, net: 108 });
    const summary = await service.summary(admin, { ...range, groupBy: 'teacher' });
    expect(summary.groups[0]).toMatchObject({ fees: 270, teacherPay: 135, platformFee: 27, net: 108 });
  });

  it('never shows the commission to teachers or students', async () => {
    const { service } = setup([session], 10);
    const asTeacher = await service.sessions(teacher, range);
    expect(asTeacher).not.toHaveProperty('platformFeePercent');
    expect(asTeacher.rows[0]).not.toHaveProperty('platformFee');
    const asStudent = await service.sessions(student, range);
    expect(asStudent).not.toHaveProperty('platformFeePercent');
    expect(asStudent.totals).not.toHaveProperty('platformFee');
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
    expect(res.groups).toEqual([{ key: '2026-10', label: null, sessions: 1, minutes: 90, fees: 270, teacherPay: 135, platformFee: 0, net: 135 }]);
  });
});

describe('BillingService.platform', () => {
  it("sums each center's fees and commission with its own percentage, per currency", async () => {
    const { prisma, service } = setup();
    const pricing = { status: 'COMPLETED', startAt: session.startAt, endAt: session.endAt, teacherId: 'tc1', courseId: 'c1', attendees: [{ studentId: 's1' }, { studentId: 's2' }] };
    const plan = { nameAr: 'احترافية', nameEn: 'Pro', priceMonthly: decimal(499), currency: 'EGP' };
    prisma.tenant.findMany.mockResolvedValue([
      { id: 't1', name: 'A', slug: 'a', status: 'ACTIVE', currency: 'EGP', platformFeePercent: decimal(10), subscription: { status: 'ACTIVE', currentPeriodEnd: null, plan }, billingRates: rates.filter((r) => r.kind === 'STUDENT_FEE'), sessions: [pricing] },
      { id: 't2', name: 'B', slug: 'b', status: 'ACTIVE', currency: 'EGP', platformFeePercent: null, subscription: null, billingRates: rates.filter((r) => r.kind === 'STUDENT_FEE'), sessions: [pricing, pricing] },
      { id: 't3', name: 'C', slug: 'c', status: 'ACTIVE', currency: 'SAR', platformFeePercent: decimal(5), subscription: null, billingRates: [], sessions: [pricing] },
    ]);
    const res = await service.platform(range);
    expect(res.tenants.map((t) => [t.id, t.sessions, t.fees, t.platformFee])).toEqual([
      ['t1', 1, 270, 27],
      ['t2', 2, 540, 0],
      ['t3', 1, 0, 0],
    ]);
    expect(res.tenants[0].subscription?.plan).toMatchObject({ priceMonthly: 499, currency: 'EGP' });
    expect(res.tenants[0].subscription?.expired).toBe(false);
    expect(res.totals).toEqual([
      { currency: 'EGP', centers: 2, withFee: 1, sessions: 3, fees: 810, platformFee: 27 },
      { currency: 'SAR', centers: 1, withFee: 1, sessions: 1, fees: 0, platformFee: 0 },
    ]);
  });
});

describe('BillingService rates', () => {
  const dto = { kind: 'STUDENT_FEE' as const, amount: 100, effectiveFrom: '2026-10-01T00:00:00Z' };

  it('rejects percentages for student fees, student-specific teacher pay, and teacher pay with no teacher', async () => {
    const { service } = setup();
    await expect(service.createRate(admin, { ...dto, basis: 'PERCENT' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createRate(admin, { ...dto, kind: 'TEACHER_PAY', teacherId: 'tc1', basis: 'PERCENT', amount: 120 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.createRate(admin, { ...dto, kind: 'TEACHER_PAY', teacherId: 'tc1', studentId: 's1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.createRate(admin, { ...dto, kind: 'TEACHER_PAY' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores a center-wide student price with no teacher', async () => {
    const { prisma, service } = setup();
    const row = await service.createRate(admin, dto);
    expect(prisma.billingRate.create.mock.calls[0][0].data).toMatchObject({ tenantId: 't1', teacherId: null, courseId: null, studentId: null });
    expect(row).toMatchObject({ source: 'CENTER', teacher: null });
  });

  it('refuses a second price for the same scope and start date', async () => {
    const { prisma, service } = setup();
    prisma.billingRate.findFirst.mockResolvedValueOnce({ id: 'twin' });
    await expect(service.createRate(admin, dto)).rejects.toBeInstanceOf(ConflictException);
  });

  it('checks a course price names a course in this center, and of the teacher when one is given', async () => {
    const { prisma, service } = setup();
    await service.createRate(admin, { ...dto, courseId: 'c1' });
    expect(prisma.course.findFirst).toHaveBeenLastCalledWith({ where: { id: 'c1', tenantId: 't1' } });
    await service.createRate(admin, { ...dto, courseId: 'c1', teacherId: 'tc1' });
    expect(prisma.course.findFirst).toHaveBeenLastCalledWith({ where: { id: 'c1', tenantId: 't1', teacherId: 'tc1' } });
    expect(prisma.billingRate.create.mock.calls[0][0].data).toMatchObject({ tenantId: 't1', courseId: 'c1', studentId: null, basis: 'PER_HOUR' });
  });

  it('shows a teacher their pay and every student price that can reach their sessions', async () => {
    const { prisma, service } = setup();
    prisma.billingRate.findMany.mockResolvedValueOnce([]);
    await service.listRates(teacher, {});
    expect(prisma.billingRate.findMany.mock.calls[0][0].where).toEqual({
      tenantId: 't1',
      kind: undefined,
      OR: [{ teacherId: 'tc1' }, { teacherId: null, courseId: null }, { teacherId: null, course: { teacherId: 'tc1' } }],
    });
  });
});
