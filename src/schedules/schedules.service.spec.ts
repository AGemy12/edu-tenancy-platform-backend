import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { vi } from 'vitest';
import { SchedulesService } from './schedules.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SessionsService } from '../sessions/sessions.service.js';
import type { CreateScheduleDto } from './dto/schedule.dto.js';

const base = { id: 'u', email: 'x@test', tenantId: 't1', teacherId: null, studentId: null, status: 'ACTIVE' as const, membershipId: 'm1' };
const teacher: JwtUser = { ...base, id: 'u-tc', role: 'TEACHER', teacherId: 'tc1' };
const otherTeacher: JwtUser = { ...base, id: 'u-tc2', role: 'TEACHER', teacherId: 'tc2' };

const nextYear = new Date().getUTCFullYear() + 1;
const dto: CreateScheduleDto = {
  studentId: 's1',
  title: 'Algebra',
  provider: 'ZOOM',
  monthlyHours: 10,
  weeklyHours: 2,
  startDate: `${nextYear}-03-01`,
  slots: [
    { weekday: 0, startTime: '17:00' },
    { weekday: 2, startTime: '18:00' },
  ],
};

function setup(over: { student?: object | null; createFails?: boolean } = {}) {
  const created = vi.fn().mockImplementation(({ data }) =>
    over.createFails
      ? Promise.reject(new Error('db down'))
      : Promise.resolve({ ...data, id: 'sch1', slots: data.slots.create, sessions: data.sessions.create }),
  );
  const tx = {
    teacherStudent: { upsert: vi.fn() },
    studentSchedule: { create: created },
    session: { findMany: vi.fn().mockResolvedValue([]) },
    $executeRaw: vi.fn(),
  };
  const prisma = {
    teacher: {
      findFirst: vi
        .fn()
        .mockImplementation(({ where }) => Promise.resolve({ id: where.id, userId: 'u-tc', tenant: { timezone: 'Africa/Cairo' } })),
    },
    student: {
      findFirst: vi.fn().mockResolvedValue(over.student === undefined ? { id: 's1', user: { email: 's@test' } } : over.student),
    },
    course: { findFirst: vi.fn() },
    session: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
    studentSchedule: {
      findFirst: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn().mockResolvedValue([{ id: 'sch1', meetingUrl: 'https://meet.example/x', startDate: new Date(), endDate: new Date(), sessions: [] }]),
    },
    $transaction: vi.fn().mockImplementation((arg) => (typeof arg === 'function' ? arg(tx) : Promise.all(arg))),
  };
  let n = 0;
  const provider = {
    createMeeting: vi.fn().mockImplementation(() => Promise.resolve({ externalMeetingId: `m${++n}`, joinUrl: `https://zoom.us/j/${n}` })),
  };
  const sessions = { providerFor: vi.fn().mockReturnValue(provider), deleteExternal: vi.fn() };
  const service = new SchedulesService(prisma as unknown as PrismaService, sessions as unknown as SessionsService);
  return { service, prisma, provider, sessions, tx, created };
}

describe('SchedulesService.create', () => {
  it('creates one session (and one Zoom meeting) per slot occurrence, all for the student', async () => {
    const { service, provider, created, tx } = setup();
    const res = await service.create(teacher, dto);

    const data = created.mock.calls[0][0].data;
    expect(data).toMatchObject({ teacherId: 'tc1', studentId: 's1', monthlyMinutes: 600, weeklyMinutes: 120 });
    expect(data.endDate.toISOString().slice(0, 10)).toBe(`${nextYear}-04-01`);
    const sessions = data.sessions.create;
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions).toHaveLength(provider.createMeeting.mock.calls.length);
    expect(sessions[0]).toMatchObject({ externalMeetingId: 'm1', attendees: { create: { studentId: 's1' } } });
    expect(sessions.every((s: { endAt: Date; startAt: Date }) => s.endAt.getTime() - s.startAt.getTime() === 3_600_000)).toBe(true);
    expect(tx.teacherStudent.upsert).toHaveBeenCalled();
    expect(res.stats.scheduledMinutes).toBe(sessions.length * 60);
  });

  it("only lets a teacher schedule their own students", async () => {
    const { service, prisma } = setup({ student: null });
    await expect(service.create(otherTeacher, dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.student.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ teachers: { some: { teacherId: 'tc2' } } }) }),
    );
  });

  it('needs a link for manual meetings', async () => {
    const { service } = setup();
    await expect(service.create(teacher, { ...dto, provider: 'MANUAL' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects slots that cannot split the weekly hours', async () => {
    const { service, provider } = setup();
    await expect(service.create(teacher, { ...dto, weeklyHours: 0.25 })).rejects.toBeInstanceOf(BadRequestException);
    expect(provider.createMeeting).not.toHaveBeenCalled();
  });

  it('deletes the Zoom meetings it made when saving fails', async () => {
    const { service, provider, sessions } = setup({ createFails: true });
    await expect(service.create(teacher, dto)).rejects.toThrow('db down');
    expect(sessions.deleteExternal).toHaveBeenCalledTimes(provider.createMeeting.mock.calls.length);
  });

  it("refuses a month that clashes with the teacher's or student's other sessions, before making meetings", async () => {
    const { service, prisma, provider } = setup();
    // Another teacher's year-long session with this student covers every slot of the month.
    prisma.session.findMany.mockResolvedValue([
      { id: 'x', title: 'Chemistry', teacherId: 'tc2', startAt: new Date(0), endAt: new Date(`${nextYear + 1}-01-01`), attendees: [] },
    ]);
    const err = await service.create(teacher, dto).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ i18n: 'schedules.clash' });
    expect(provider.createMeeting).not.toHaveBeenCalled();
  });

  it('locks the teacher and the student while saving, and checks again', async () => {
    const { service, tx } = setup();
    await service.create(teacher, dto);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.session.findMany).toHaveBeenCalled();
  });
});

describe('SchedulesService.list', () => {
  it('keeps the meeting link from a suspended teacher', async () => {
    const { service } = setup();
    expect((await service.list(teacher))[0].meetingUrl).toBe('https://meet.example/x');
    expect((await service.list({ ...teacher, status: 'SUSPENDED' }))[0].meetingUrl).toBeNull();
  });
});

describe('SchedulesService.remove', () => {
  it('removes only upcoming sessions and their meetings', async () => {
    const { service, prisma, sessions } = setup();
    prisma.studentSchedule.findFirst.mockResolvedValue({ id: 'sch1', teacherId: 'tc1', teacher: { userId: 'u-tc' } });
    prisma.session.findMany.mockResolvedValue([
      { id: 'a', provider: 'ZOOM', externalMeetingId: 'm1' },
      { id: 'b', provider: 'MANUAL', externalMeetingId: null },
    ]);
    await service.remove(teacher, 'sch1');
    expect(prisma.session.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ scheduleId: 'sch1', status: 'SCHEDULED' }) }),
    );
    expect(sessions.deleteExternal).toHaveBeenCalledWith('ZOOM', 'u-tc', 'm1');
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['a', 'b'] } } });
  });

  it("refuses another teacher's schedule", async () => {
    const { service, prisma } = setup();
    prisma.studentSchedule.findFirst.mockResolvedValue({ id: 'sch1', teacherId: 'tc1', teacher: { userId: 'u-tc' } });
    await expect(service.remove(otherTeacher, 'sch1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
