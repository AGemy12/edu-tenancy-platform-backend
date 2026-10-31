import { BadRequestException } from '@nestjs/common';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MessagingService } from '../messaging/messaging.service.js';
import type { ZoomProvider } from './providers/zoom.provider.js';
import type { SessionsService } from './sessions.service.js';
import { CallsService } from './calls.service.js';
import { RING_MS } from './call-rules.js';

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

const teacher: JwtUser = { id: 'u-t', role: 'TEACHER', tenantId: 't1', teacherId: 'tc1', studentId: null, membershipId: 'm-t', status: 'ACTIVE' } as JwtUser;
const student: JwtUser = { id: 'u-s', role: 'STUDENT', tenantId: 't1', teacherId: null, studentId: 's1', membershipId: 'm-s', status: 'ACTIVE' } as JwtUser;

const members = {
  'm-t': { membershipId: 'm-t', role: 'TEACHER', status: 'ACTIVE', teacherId: 'tc1', studentId: null },
  'm-s': { membershipId: 'm-s', role: 'STUDENT', status: 'ACTIVE', teacherId: null, studentId: 's1' },
} as const;

function makeSession(over: Record<string, unknown> = {}) {
  return {
    id: 'ses1',
    status: 'LIVE',
    startedAt: inMinutes(-40),
    endedAt: null,
    startAt: inMinutes(-40),
    endAt: inMinutes(20),
    title: 'Algebra',
    provider: 'ZOOM',
    meetingUrl: 'https://zoom.us/j/1',
    teacher: { userId: 'u-t' },
    tenant: { timezone: 'Africa/Cairo' },
    ...over,
  };
}

function makeCall(over: Record<string, unknown> = {}) {
  return {
    id: 'call1',
    sessionId: 'ses1',
    conversationId: 'conv1',
    callerId: 'm-s',
    status: 'RINGING',
    joinUrl: 'https://zoom.us/j/999',
    externalMeetingId: '999',
    answeredAt: null,
    endedAt: null,
    createdAt: new Date(),
    ...over,
  };
}

function setup({ session = makeSession() as ReturnType<typeof makeSession> | null, last = null as ReturnType<typeof makeCall> | null } = {}) {
  let stored = last;
  const prisma = {
    session: {
      findMany: vi.fn().mockResolvedValue(session ? [session] : []),
      findUniqueOrThrow: vi.fn().mockResolvedValue(session),
    },
    sessionCall: {
      findFirst: vi.fn().mockImplementation(({ where }: { where: { id?: string } }) => Promise.resolve(where.id && stored?.id !== where.id ? null : stored)),
      findUniqueOrThrow: vi.fn().mockImplementation(() => Promise.resolve(stored)),
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        stored = makeCall({ ...data, id: 'call2' });
        return Promise.resolve(stored);
      }),
      updateMany: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        stored = { ...stored!, ...data };
        return Promise.resolve({ count: 1 });
      }),
    },
    sessionAttendee: {
      findUnique: vi.fn().mockResolvedValue({ studentId: 's1', attended: false, joinedAt: null }),
      update: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const messaging = {
    directPair: vi.fn().mockImplementation((user: JwtUser) =>
      Promise.resolve(user.membershipId === 'm-t' ? { self: members['m-t'], other: members['m-s'] } : { self: members['m-s'], other: members['m-t'] }),
    ),
    callMessage: vi.fn(),
    pushCall: vi.fn().mockResolvedValue(undefined),
  };
  const sessions = { meetingStarted: vi.fn(), meetingEnded: vi.fn(), deleteExternal: vi.fn() };
  const zoom = {
    createMeeting: vi.fn().mockResolvedValue({ externalMeetingId: '999', joinUrl: 'https://zoom.us/j/999' }),
    hostUrl: vi.fn().mockResolvedValue('https://zoom.us/s/999?zak=host'),
  };
  const service = new CallsService(
    prisma as unknown as PrismaService,
    messaging as unknown as MessagingService,
    sessions as unknown as SessionsService,
    zoom as unknown as ZoomProvider,
  );
  return { prisma, messaging, sessions, zoom, service, stored: () => stored };
}

describe('placing a call', () => {
  it('lets the student call the teacher back after the meeting dropped: a fresh Zoom meeting, a card in the chat, attendance', async () => {
    const { prisma, messaging, zoom, service } = setup({ last: makeCall({ status: 'ENDED' }) });
    const res = await service.place(student, 'conv1');
    expect(zoom.createMeeting).toHaveBeenCalledWith(expect.objectContaining({ hostUserId: 'u-t', title: 'Algebra' }));
    expect(prisma.sessionCall.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ callerId: 'm-s', externalMeetingId: '999' }) }));
    expect(messaging.callMessage).toHaveBeenCalledWith(prisma, 'conv1', 't1', 'm-s', 'call2');
    expect(messaging.pushCall).toHaveBeenCalledWith('call2', true);
    expect(prisma.sessionAttendee.update).toHaveBeenCalledWith(expect.objectContaining({ data: { attended: true, joinedAt: expect.any(Date) } }));
    expect(res.url).toBe('https://zoom.us/j/999');
    expect(res.call.status).toBe('RINGING');
  });

  it('gives the teacher the host link and starts the session', async () => {
    const { sessions, service } = setup();
    const res = await service.place(teacher, 'conv1');
    expect(res.url).toBe('https://zoom.us/s/999?zak=host');
    expect(sessions.meetingStarted).toHaveBeenCalledWith(expect.objectContaining({ id: 'ses1' }), expect.any(Date), 'u-t');
  });

  it('reuses the session link for Meet and pasted links', async () => {
    const { zoom, service } = setup({ session: makeSession({ provider: 'GOOGLE_MEET', meetingUrl: 'https://meet.google.com/abc' }) });
    const res = await service.place(student, 'conv1');
    expect(zoom.createMeeting).not.toHaveBeenCalled();
    expect(res.url).toBe('https://meet.google.com/abc');
  });

  it('answers instead when the other side is already ringing', async () => {
    const { prisma, zoom, service, stored } = setup({ last: makeCall({ callerId: 'm-s' }) });
    await service.place(teacher, 'conv1');
    expect(zoom.createMeeting).not.toHaveBeenCalled();
    expect(prisma.sessionCall.create).not.toHaveBeenCalled();
    expect(stored()!.status).toBe('ACTIVE');
  });

  it('places a new call once the last ring went unanswered', async () => {
    const { prisma, service } = setup({ last: makeCall({ createdAt: new Date(Date.now() - RING_MS - 1_000) }) });
    await service.place(student, 'conv1');
    expect(prisma.sessionCall.create).toHaveBeenCalled();
  });

  it('is closed when no session of theirs is on', async () => {
    const { zoom, service } = setup({ session: null });
    await expect(service.place(student, 'conv1')).rejects.toBeInstanceOf(BadRequestException);
    expect(zoom.createMeeting).not.toHaveBeenCalled();
  });

  it('only connects a teacher with their student', async () => {
    const { messaging, service } = setup();
    messaging.directPair.mockResolvedValue({ self: members['m-t'], other: { ...members['m-t'], membershipId: 'm-t2', teacherId: 'tc2' } });
    await expect(service.place(teacher, 'conv1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removes the meeting it made when the call could not be saved', async () => {
    const { prisma, sessions, service } = setup();
    prisma.sessionCall.create.mockRejectedValueOnce(new Error('db down'));
    await expect(service.place(student, 'conv1')).rejects.toThrow('db down');
    expect(sessions.deleteExternal).toHaveBeenCalledWith('ZOOM', 'u-t', '999');
  });
});

describe('joining and ending', () => {
  it('turns a ringing call active when the other side joins', async () => {
    const { messaging, service, stored } = setup({ last: makeCall() });
    const res = await service.join(teacher, 'call1');
    expect(stored()!.status).toBe('ACTIVE');
    expect(messaging.pushCall).toHaveBeenCalledWith('call1', false);
    expect(res.url).toBe('https://zoom.us/s/999?zak=host');
  });

  it('refuses a call that is over', async () => {
    const { service } = setup({ last: makeCall({ status: 'ENDED' }) });
    await expect(service.join(student, 'call1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('declining a ring makes it missed and removes its unused meeting', async () => {
    const { sessions, service, stored } = setup({ last: makeCall() });
    await service.end(teacher, 'call1');
    expect(stored()!.status).toBe('MISSED');
    expect(sessions.deleteExternal).toHaveBeenCalledWith('ZOOM', 'u-t', '999');
  });

  it('hanging up a call in progress ends it and leaves the meeting alone', async () => {
    const { sessions, service, stored } = setup({ last: makeCall({ status: 'ACTIVE' }) });
    await service.end(student, 'call1');
    expect(stored()!.status).toBe('ENDED');
    expect(sessions.deleteExternal).not.toHaveBeenCalled();
  });
});

describe('Zoom events for a call', () => {
  it("ends the call when its meeting stops, and tells the session (which stays live if it's early)", async () => {
    const { prisma, sessions, service, stored } = setup({ last: makeCall({ status: 'ACTIVE' }) });
    prisma.sessionCall.findFirst.mockResolvedValue({ ...makeCall({ status: 'ACTIVE' }), session: makeSession() });
    const endedAt = new Date();
    await service.providerEnded('999', null, endedAt);
    expect(stored()!.status).toBe('ENDED');
    expect(sessions.meetingEnded).toHaveBeenCalledWith(expect.objectContaining({ id: 'ses1' }), null, endedAt);
    expect(sessions.deleteExternal).toHaveBeenCalledWith('ZOOM', 'u-t', '999');
  });

  it('ignores meetings that are not calls', async () => {
    const { prisma, sessions, service } = setup();
    prisma.sessionCall.findFirst.mockResolvedValue(null);
    await service.providerEnded('111', null, new Date());
    expect(sessions.meetingEnded).not.toHaveBeenCalled();
  });
});
