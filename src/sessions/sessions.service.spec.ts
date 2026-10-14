import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { vi } from 'vitest';
import { SessionsService } from './sessions.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ConfigService } from '@nestjs/config';
import type { ZoomProvider } from './providers/zoom.provider.js';
import type { GoogleMeetProvider } from './providers/google-meet.provider.js';

const base = { id: 'u', email: 'x@test', tenantId: 't1', teacherId: null, studentId: null, status: 'ACTIVE' as const, membershipId: 'm1' };
const host: JwtUser = { ...base, id: 'u-host', role: 'TEACHER', teacherId: 'tc1' };
const admin: JwtUser = { ...base, id: 'u-admin', role: 'TENANT_ADMIN' };
const student: JwtUser = { ...base, id: 'u-st', role: 'STUDENT', studentId: 's1' };

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

function makeSession(over: Record<string, unknown> = {}) {
  return {
    id: 'ses1',
    tenantId: 't1',
    teacherId: 'tc1',
    title: 'Algebra',
    description: null,
    provider: 'ZOOM',
    status: 'SCHEDULED',
    startAt: inMinutes(5),
    endAt: inMinutes(65),
    meetingUrl: 'https://zoom.us/j/1?pwd=x',
    externalMeetingId: '111',
    startedAt: null,
    endedAt: null,
    teacher: { userId: 'u-host' },
    tenant: { timezone: 'Africa/Cairo' },
    ...over,
  };
}

function setup(session = makeSession(), attendee: object | null = null) {
  const prisma = {
    session: {
      findFirst: vi.fn().mockResolvedValue(session),
      findMany: vi.fn().mockResolvedValue([session]),
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...session, ...data })),
      create: vi.fn(),
    },
    sessionAttendee: {
      findUnique: vi.fn().mockResolvedValue(attendee),
      findMany: vi.fn().mockResolvedValue([{ studentId: 's1' }]),
      update: vi.fn(),
    },
    teacher: {
      findFirst: vi.fn().mockResolvedValue({ id: 'tc1', user: { id: 'u-host' }, tenant: { timezone: 'Africa/Cairo' } }),
    },
    student: { findMany: vi.fn().mockResolvedValue([]) },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const zoom = {
    createMeeting: vi.fn().mockResolvedValue({ externalMeetingId: '999', joinUrl: 'https://zoom.us/j/999' }),
    updateMeeting: vi.fn(),
    deleteMeeting: vi.fn(),
    hostUrl: vi.fn().mockResolvedValue('https://zoom.us/s/1?zak=fresh'),
  };
  const config = { get: vi.fn() };
  const service = new SessionsService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    zoom as unknown as ZoomProvider,
    {} as GoogleMeetProvider,
  );
  return { prisma, zoom, service };
}

describe('start', () => {
  it('gives the host a fresh Zoom start link and marks the session live', async () => {
    const { prisma, service } = setup();
    await expect(service.start(host, 'ses1')).resolves.toEqual({ url: 'https://zoom.us/s/1?zak=fresh' });
    expect(prisma.session.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'LIVE', startedAt: expect.any(Date) }) }),
    );
  });

  it("never hands an admin the teacher's start link", async () => {
    const { zoom, service } = setup();
    await expect(service.start(admin, 'ses1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(zoom.hostUrl).not.toHaveBeenCalled();
  });

  it('refuses too early, and after the end', async () => {
    await expect(setup(makeSession({ startAt: inMinutes(60) })).service.start(host, 'ses1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(setup(makeSession({ status: 'COMPLETED' })).service.start(host, 'ses1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('stays scheduled if Zoom fails', async () => {
    const { prisma, zoom, service } = setup();
    zoom.hostUrl.mockRejectedValue(new Error('zoom down'));
    await expect(service.start(host, 'ses1')).rejects.toThrow('zoom down');
    expect(prisma.session.update).not.toHaveBeenCalled();
  });
});

describe('update', () => {
  it('moves the Zoom meeting along with the session', async () => {
    const { zoom, service } = setup();
    const startAt = inMinutes(120).toISOString();
    const endAt = inMinutes(180).toISOString();
    await service.update(host, 'ses1', { startAt, endAt });
    expect(zoom.updateMeeting).toHaveBeenCalledWith(
      'u-host',
      '111',
      expect.objectContaining({ startAt: new Date(startAt), endAt: new Date(endAt), timezone: 'Africa/Cairo' }),
    );
  });

  it("doesn't call Zoom for notes only", async () => {
    const { zoom, service } = setup(makeSession({ status: 'COMPLETED' }));
    await service.update(host, 'ses1', { notes: 'Covered chapter 3' });
    expect(zoom.updateMeeting).not.toHaveBeenCalled();
  });

  it('accepts the unchanged times a form sends back without seconds', async () => {
    const startAt = new Date('2026-10-14T16:00:42Z');
    const endAt = new Date('2026-10-14T17:00:42Z');
    const { zoom, service } = setup(makeSession({ status: 'COMPLETED', startAt, endAt }));
    await service.update(host, 'ses1', {
      startAt: '2026-10-14T16:00:00Z',
      endAt: '2026-10-14T17:00:00Z',
      notes: 'Covered chapter 3',
    });
    expect(zoom.updateMeeting).not.toHaveBeenCalled();
  });

  it('refuses to move a session that already started, or edit a generated link', async () => {
    const live = setup(makeSession({ status: 'LIVE' }));
    await expect(live.service.update(host, 'ses1', { startAt: inMinutes(30).toISOString() })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const zoomed = setup();
    await expect(zoomed.service.update(host, 'ses1', { meetingUrl: 'https://evil.test' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('join', () => {
  it('records attendance when a student takes the link', async () => {
    const { prisma, service } = setup(makeSession(), { studentId: 's1', attended: false, joinedAt: null });
    await expect(service.join(student, 'ses1')).resolves.toEqual({ url: 'https://zoom.us/j/1?pwd=x' });
    expect(prisma.sessionAttendee.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { attended: true, joinedAt: expect.any(Date) } }),
    );
  });

  it('keeps students out who are not invited, early, or late', async () => {
    await expect(setup(makeSession(), null).service.join(student, 'ses1')).rejects.toBeInstanceOf(ForbiddenException);
    const attendee = { studentId: 's1', attended: false, joinedAt: null };
    await expect(
      setup(makeSession({ startAt: inMinutes(60) }), attendee).service.join(student, 'ses1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      setup(makeSession({ status: 'CANCELED' }), attendee).service.join(student, 'ses1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('hides the link from students everywhere else', async () => {
    const { service } = setup();
    const [row] = await service.list(student);
    expect(row.meetingUrl).toBeNull();
    const [own] = await service.list(host);
    expect(own.meetingUrl).toBe('https://zoom.us/j/1?pwd=x');
  });

  it('gives a suspended teacher no link, in lists or details, so the meeting cannot be opened around the block', async () => {
    const suspended: JwtUser = { ...host, status: 'SUSPENDED' };
    const { prisma, service } = setup();
    prisma.session.findFirst.mockResolvedValue({ ...makeSession(), attendees: [] });
    const [row] = await service.list(suspended);
    expect(row.meetingUrl).toBeNull();
    const detail = await service.get(suspended, 'ses1');
    expect(detail.meetingUrl).toBeNull();
  });
});

describe('complete', () => {
  it('ends a live session even if it started early', async () => {
    const { prisma, service } = setup(makeSession({ status: 'LIVE', startAt: inMinutes(5) }));
    await service.complete(host, 'ses1');
    expect(prisma.session.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'COMPLETED', endedAt: expect.any(Date) } }),
    );
  });

  it("won't close a scheduled session before its time", async () => {
    const { service } = setup(makeSession({ startAt: inMinutes(60) }));
    await expect(service.complete(host, 'ses1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('closeOverdue', () => {
  it('marks unstarted Zoom sessions missed only when Zoom events are on', async () => {
    const run = async (secret?: string) => {
      const { prisma, service } = setup();
      Object.assign(prisma.session, { updateMany: vi.fn() });
      (service as unknown as { config: { get: () => unknown } }).config.get = () => secret;
      await service.closeOverdue(new Date());
      const calls = (prisma.session as unknown as { updateMany: { mock: { calls: [{ where: { status: string; provider?: string }; data: { status: string } }][] } } }).updateMany.mock.calls;
      return calls.find(([a]) => a.where.status === 'SCHEDULED' && a.where.provider === 'ZOOM')?.[0].data.status;
    };
    expect(await run('secret')).toBe('MISSED');
    expect(await run(undefined)).toBe('COMPLETED');
  });
});

describe('cancel and create', () => {
  it('cancels only before the start, and removes the Zoom meeting', async () => {
    const { zoom, service } = setup();
    await service.cancel(host, 'ses1');
    expect(zoom.deleteMeeting).toHaveBeenCalledWith('u-host', '111');
    await expect(setup(makeSession({ status: 'LIVE' })).service.cancel(host, 'ses1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('deletes the new Zoom meeting if saving the session fails', async () => {
    const { prisma, zoom, service } = setup();
    prisma.session.findMany.mockResolvedValue([]);
    prisma.session.create.mockRejectedValue(new Error('db down'));
    await expect(
      service.create(host, {
        title: 'Algebra',
        provider: 'ZOOM',
        startAt: inMinutes(60).toISOString(),
        endAt: inMinutes(120).toISOString(),
      }),
    ).rejects.toThrow('db down');
    expect(zoom.deleteMeeting).toHaveBeenCalledWith('u-host', '999');
  });
});

describe('evaluate', () => {
  const evaluation = { studentId: 's1', status: 'LATE' as const, rating: 8, homework: 'Exercises 1–5', progress: 'Chapter 3' };

  function withAttendees(session = makeSession({ startAt: inMinutes(-60), endAt: inMinutes(-1), status: 'COMPLETED' })) {
    const ctx = setup(session);
    Object.assign(ctx.prisma, {
      sessionAttendee: { ...ctx.prisma.sessionAttendee, count: vi.fn().mockResolvedValue(1), update: vi.fn((args) => args) },
      $transaction: vi.fn().mockResolvedValue([]),
    });
    return ctx;
  }

  it("saves each student's evaluation, with attendance following the status", async () => {
    const { prisma, service } = withAttendees();
    await service.evaluate(host, 'ses1', { evaluations: [evaluation] });
    expect(prisma.sessionAttendee.update).toHaveBeenCalledWith({
      where: { sessionId_studentId: { sessionId: 'ses1', studentId: 's1' } },
      data: expect.objectContaining({ status: 'LATE', attended: true, rating: 8, homework: 'Exercises 1–5', progress: 'Chapter 3' }),
    });
  });

  it("refuses sessions that haven't started, canceled ones, and students outside the session", async () => {
    await expect(withAttendees(makeSession()).service.evaluate(host, 'ses1', { evaluations: [evaluation] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const canceled = withAttendees(makeSession({ startAt: inMinutes(-60), status: 'CANCELED' }));
    await expect(canceled.service.evaluate(host, 'ses1', { evaluations: [evaluation] })).rejects.toBeInstanceOf(BadRequestException);
    const outsider = withAttendees();
    (outsider.prisma.sessionAttendee as unknown as { count: ReturnType<typeof vi.fn> }).count.mockResolvedValue(0);
    await expect(outsider.service.evaluate(host, 'ses1', { evaluations: [evaluation] })).rejects.toThrow();
  });

  it("only lets the session's own teacher evaluate, not another teacher or an admin", async () => {
    const { prisma, service } = withAttendees();
    await expect(service.evaluate({ ...host, teacherId: 'other' }, 'ses1', { evaluations: [evaluation] })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.evaluate(admin, 'ses1', { evaluations: [evaluation] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.markAttendance(admin, 'ses1', 's1', true)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.sessionAttendee.update).not.toHaveBeenCalled();
  });

  it("lets an admin who teaches the session evaluate it", async () => {
    const { service } = withAttendees();
    await expect(
      service.evaluate({ ...admin, teacherId: 'tc1' }, 'ses1', { evaluations: [evaluation] }),
    ).resolves.toBeDefined();
  });
});

describe('clashes', () => {
  const tomorrow = inMinutes(24 * 60).getTime();
  const at = (m: number) => new Date(tomorrow + m * 60_000);
  const draft = { title: 'Physics', provider: 'ZOOM' as const, startAt: at(0).toISOString(), endAt: at(60).toISOString() };
  const other = (over: Record<string, unknown> = {}) => ({
    id: 'other',
    title: 'Chemistry',
    teacherId: 'tc1',
    startAt: at(30),
    endAt: at(90),
    attendees: [],
    ...over,
  });
  const key = (e: unknown) => ((e as ConflictException).getResponse() as { i18n?: string; params?: object }).i18n;

  it("won't book a teacher into two sessions at once, and makes no meeting", async () => {
    const { prisma, zoom, service } = setup();
    prisma.session.findMany.mockResolvedValue([other()]);
    const err = await service.create(host, draft).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(key(err)).toBe('sessions.teacherBusy');
    expect(zoom.createMeeting).not.toHaveBeenCalled();
  });

  it('names the student who is already busy with another teacher', async () => {
    const { prisma, service } = setup();
    prisma.student.findMany.mockResolvedValue([{ id: 's1', user: { email: 's@test' } }]);
    prisma.session.findMany.mockResolvedValue([
      other({ teacherId: 'tc2', attendees: [{ student: { user: { fullName: 'Sara' } } }] }),
    ]);
    const err = await service.create(host, { ...draft, studentIds: ['s1'] }).catch((e: unknown) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({ i18n: 'sessions.studentBusy', params: { name: 'Sara' } });
    expect(prisma.session.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['SCHEDULED', 'LIVE'] },
          OR: [{ teacherId: 'tc1' }, { attendees: { some: { studentId: { in: ['s1'] } } } }],
        }),
      }),
    );
  });

  it('allows back-to-back sessions', async () => {
    const { prisma, service } = setup();
    prisma.session.findMany.mockResolvedValue([other({ startAt: at(60), endAt: at(120) }), other({ startAt: at(-60), endAt: at(0) })]);
    prisma.session.create.mockResolvedValue({ id: 'new' });
    await expect(service.create(host, draft)).resolves.toEqual({ id: 'new' });
  });

  it('checks again under a lock, and drops the meeting if the slot was taken meanwhile', async () => {
    const { prisma, zoom, service } = setup();
    prisma.session.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([other()]);
    await expect(service.create(host, draft)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(zoom.deleteMeeting).toHaveBeenCalledWith('u-host', '999');
  });

  it("won't move a session onto another one, but ignores the session itself", async () => {
    const { prisma, zoom, service } = setup();
    prisma.session.findMany.mockResolvedValue([other()]);
    const move = { startAt: at(0).toISOString(), endAt: at(60).toISOString() };
    await expect(service.update(host, 'ses1', move)).rejects.toBeInstanceOf(ConflictException);
    expect(zoom.updateMeeting).not.toHaveBeenCalled();
    expect(prisma.session.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { not: 'ses1' } }) }),
    );
  });
});

describe('remove', () => {
  it('deletes a session that has not started, with its Zoom meeting', async () => {
    const { prisma, zoom, service } = setup(makeSession({ startAt: inMinutes(60), endAt: inMinutes(120) }));
    Object.assign(prisma.session, { delete: vi.fn() });
    await service.remove(host, 'ses1');
    expect(zoom.deleteMeeting).toHaveBeenCalledWith('u-host', '111');
    expect((prisma.session as unknown as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalled();
  });

  it('keeps sessions that are part of the record: held, live, missed, canceled or already due', async () => {
    for (const over of [
      { status: 'COMPLETED', startAt: inMinutes(-120), endAt: inMinutes(-60) },
      { status: 'LIVE' },
      { status: 'MISSED', startAt: inMinutes(-120), endAt: inMinutes(-60) },
      { status: 'CANCELED', startAt: inMinutes(60) },
      { status: 'SCHEDULED', startAt: inMinutes(-5) },
    ]) {
      const { prisma, zoom, service } = setup(makeSession(over));
      Object.assign(prisma.session, { delete: vi.fn() });
      await expect(service.remove(admin, 'ses1')).rejects.toBeInstanceOf(BadRequestException);
      expect((prisma.session as unknown as { delete: ReturnType<typeof vi.fn> }).delete).not.toHaveBeenCalled();
      expect(zoom.deleteMeeting).not.toHaveBeenCalled();
    }
  });
});
