import { BadRequestException } from '@nestjs/common';
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

const attendee = (studentId: string, name: string, attended: boolean, status: string | null = null) => ({
  studentId,
  attended,
  status,
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

// The center's default price per session, one student's special price in the course, and the teacher's share.
const rates = [
  { id: 'r1', kind: 'STUDENT_FEE', basis: 'PER_SESSION', teacherId: null, courseId: null, studentId: null, amount: decimal(100), cleared: false, effectiveFrom: new Date('2026-01-01') },
  { id: 'r2', kind: 'STUDENT_FEE', basis: 'PER_SESSION', teacherId: null, courseId: 'c1', studentId: 's2', amount: decimal(80), cleared: false, effectiveFrom: new Date('2026-01-01') },
  { id: 'r3', kind: 'TEACHER_PAY', basis: 'PERCENT', teacherId: 'tc1', courseId: null, studentId: null, amount: decimal(50), cleared: false, effectiveFrom: new Date('2026-01-01') },
];

function setup(sessions = [session], platformFeePercent: number | null = null, opts: { planFee?: number; chargeAbsent?: boolean } = {}) {
  const prisma = {
    tenant: {
      findUnique: vi.fn().mockResolvedValue({
        currency: 'EGP',
        timezone: 'Africa/Cairo',
        chargeAbsent: opts.chargeAbsent ?? true,
        platformFeePercent: platformFeePercent === null ? null : decimal(platformFeePercent),
        subscription: { plan: { platformFeePercent: opts.planFee === undefined ? null : decimal(opts.planFee) } },
      }),
      findMany: vi.fn(),
    },
    session: { findMany: vi.fn().mockResolvedValue(sessions) },
    billingRate: {
      findMany: vi.fn().mockResolvedValue(rates),
    },
  };
  return { prisma, service: new BillingService(prisma as unknown as PrismaService) };
}

describe('BillingService.sessions', () => {
  it('charges each student on a held session its price per session, present or not before evaluation', async () => {
    const { service } = setup();
    const res = await service.sessions(admin, range);
    const row = res.rows[0];
    expect(row.minutes).toBe(90);
    expect(row.actualMinutes).toBe(79);
    // Sara: the center's 100 per session; Omar: his special 80 in this course, though he didn't join.
    expect(row.students.map((s) => [s.name, s.fee, s.rateSource, s.charged])).toEqual([
      ['Sara', 100, 'CENTER', true],
      ['Omar', 80, 'STUDENT', true],
    ]);
    expect(row.fees).toBe(180);
    expect(row.teacherPay).toEqual({ amount: 90, basis: 'PERCENT', rate: 50, source: 'TEACHER' });
    expect(row.platformFee).toBe(0);
    expect(row.net).toBe(90);
    expect(res.platformFeePercent).toBeNull();
    expect(res.totals).toMatchObject({ sessions: 1, minutes: 90, studentMinutes: 180, fees: 180, teacherPay: 90, platformFee: 0, net: 90, freeSeats: 0 });
  });

  it('leaves excused students out, and absent ones when the center charges no absences', async () => {
    const evaluated = { ...session, attendees: [attendee('s1', 'Sara', true, 'PRESENT'), attendee('s2', 'Omar', false, 'ABSENT')] };
    const charged = await setup([evaluated]).service.sessions(admin, range);
    expect(charged.rows[0].fees).toBe(180);
    const free = await setup([evaluated], null, { chargeAbsent: false }).service.sessions(admin, range);
    expect(free.rows[0].students.map((s) => [s.name, s.fee, s.free])).toEqual([
      ['Sara', 100, null],
      ['Omar', 0, 'ABSENT'],
    ]);
    expect(free.totals).toMatchObject({ fees: 100, teacherPay: 50, freeSeats: 1 });
    const excused = { ...session, attendees: [attendee('s1', 'Sara', false, 'EXCUSED')] };
    const none = await setup([excused]).service.sessions(admin, range);
    expect(none.rows[0]).toMatchObject({ fees: 0, teacherPay: { amount: 0 } });
  });

  it('takes the package fee when the center has none of its own', async () => {
    const { service } = setup([session], null, { planFee: 10 });
    const res = await service.sessions(admin, range);
    expect(res.platformFeePercent).toBe(10);
    expect(res.rows[0]).toMatchObject({ platformFee: 18, net: 72 });
    const own = await setup([session], 0, { planFee: 10 }).service.sessions(admin, range);
    expect(own.platformFeePercent).toBeNull();
  });

  it("takes the platform's commission out of the center's net, not the teacher's pay", async () => {
    const { service } = setup([session], 10);
    const res = await service.sessions(admin, range);
    expect(res.platformFeePercent).toBe(10);
    // 10% of 180 = 18; net = 180 − 90 − 18.
    expect(res.rows[0]).toMatchObject({ fees: 180, platformFee: 18, net: 72 });
    expect(res.rows[0].teacherPay?.amount).toBe(90);
    expect(res.totals).toMatchObject({ platformFee: 18, net: 72 });
    const summary = await service.summary(admin, { ...range, groupBy: 'teacher' });
    expect(summary.groups[0]).toMatchObject({ fees: 180, teacherPay: 90, platformFee: 18, net: 72 });
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
    expect(res.rows[0].fees).toBe(100);
    expect(res.rows[0]).not.toHaveProperty('teacherPay');
    expect(res.totals).not.toHaveProperty('teacherPay');
  });

  it("keeps the teacher's share on the whole session when one student is filtered", async () => {
    const { service } = setup();
    const res = await service.sessions(admin, { ...range, studentId: 's1' });
    expect(res.rows[0].fees).toBe(100);
    expect(res.rows[0].teacherPay?.amount).toBe(90);
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
      ['Sara', 90, 100],
      ['Omar', 90, 80],
    ]);
    expect(res.groups[0]).not.toHaveProperty('teacherPay');
  });

  it('groups by month in the center time zone', async () => {
    const { service } = setup();
    const res = await service.summary(admin, { ...range, groupBy: 'month' });
    expect(res.groups).toEqual([{ key: '2026-10', label: null, sessions: 1, minutes: 90, fees: 180, teacherPay: 90, platformFee: 0, net: 90 }]);
  });
});

describe('BillingService.platform', () => {
  it("sums each center's fees and its fee (its own percentage, else its package's), per currency", async () => {
    const { prisma, service } = setup();
    const pricing = { status: 'COMPLETED', startAt: session.startAt, teacherId: 'tc1', courseId: 'c1', attendees: [{ studentId: 's1', status: null }, { studentId: 's2', status: null }] };
    const plan = { nameAr: 'احترافية', nameEn: 'Pro', priceMonthly: decimal(499), currency: 'EGP', platformFeePercent: decimal(5) };
    const fees = rates.filter((r) => r.kind === 'STUDENT_FEE');
    const center = { status: 'ACTIVE', chargeAbsent: true };
    prisma.tenant.findMany.mockResolvedValue([
      { ...center, id: 't1', name: 'A', slug: 'a', currency: 'EGP', platformFeePercent: decimal(10), subscription: { status: 'ACTIVE', currentPeriodEnd: null, plan }, billingRates: fees, sessions: [pricing] },
      { ...center, id: 't2', name: 'B', slug: 'b', currency: 'EGP', platformFeePercent: null, subscription: null, billingRates: fees, sessions: [pricing, pricing] },
      { ...center, id: 't3', name: 'C', slug: 'c', currency: 'SAR', platformFeePercent: decimal(5), subscription: null, billingRates: [], sessions: [pricing] },
      { ...center, id: 't4', name: 'D', slug: 'd', currency: 'EGP', platformFeePercent: null, subscription: { status: 'ACTIVE', currentPeriodEnd: null, plan }, billingRates: fees, sessions: [pricing] },
    ]);
    const res = await service.platform(range);
    expect(res.tenants.map((t) => [t.id, t.sessions, t.fees, t.platformFee, t.platformFeeFromPlan])).toEqual([
      ['t1', 1, 180, 18, false],
      ['t4', 1, 180, 9, true],
      ['t2', 2, 360, 0, true],
      ['t3', 1, 0, 0, false],
    ]);
    expect(res.tenants[0].subscription?.plan).toMatchObject({ priceMonthly: 499, currency: 'EGP' });
    expect(res.tenants[0].subscription?.expired).toBe(false);
    expect(res.totals).toEqual([
      { currency: 'EGP', centers: 3, withFee: 2, sessions: 4, fees: 720, platformFee: 27 },
      { currency: 'SAR', centers: 1, withFee: 1, sessions: 1, fees: 0, platformFee: 0 },
    ]);
  });
});
