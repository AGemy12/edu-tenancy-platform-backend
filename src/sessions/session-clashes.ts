import { ConflictException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { msg } from '../i18n/i18n.js';

/**
 * Nobody can be in two sessions at once: a teacher can't host, and a student can't attend, two
 * open sessions (scheduled or live) whose times overlap. Back-to-back sessions are fine.
 */

export type TimeRange = { startAt: Date; endAt: Date };
export type People = { teacherId: string; studentIds: string[] };
export type Clash = {
  id: string;
  title: string;
  teacherId: string;
  startAt: Date;
  endAt: Date;
  /** The given students who are in it. */
  attendees: { student: { user: { fullName: string } } }[];
};

type Db = Pick<Prisma.TransactionClient, 'session' | '$executeRaw'>;

export const overlaps = (a: TimeRange, b: TimeRange) => a.startAt < b.endAt && b.startAt < a.endAt;

/** For each range, the first open session of the teacher or one of the students that overlaps it (or null). */
export async function findClashes(
  db: Db,
  tenantId: string,
  people: People,
  ranges: TimeRange[],
  excludeSessionId?: string,
): Promise<(Clash | null)[]> {
  if (ranges.length === 0) return [];
  const from = new Date(Math.min(...ranges.map((r) => r.startAt.getTime())));
  const to = new Date(Math.max(...ranges.map((r) => r.endAt.getTime())));
  const { teacherId, studentIds } = people;
  const existing = await db.session.findMany({
    where: {
      tenantId,
      ...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
      status: { in: ['SCHEDULED', 'LIVE'] },
      startAt: { lt: to },
      endAt: { gt: from },
      OR: [{ teacherId }, ...(studentIds.length ? [{ attendees: { some: { studentId: { in: studentIds } } } }] : [])],
    },
    select: {
      id: true,
      title: true,
      teacherId: true,
      startAt: true,
      endAt: true,
      attendees: {
        where: { studentId: { in: studentIds } },
        select: { student: { select: { user: { select: { fullName: true } } } } },
      },
    },
    orderBy: { startAt: 'asc' },
  });
  return ranges.map((r) => existing.find((e) => overlaps(r, e)) ?? null);
}

/** What to tell the user about a clash: the teacher is busy, or which student is. */
export function clashError(clash: Clash, teacherId: string) {
  if (clash.teacherId === teacherId) return new ConflictException(msg('sessions.teacherBusy', { title: clash.title }));
  const name = clash.attendees[0]?.student.user.fullName ?? '';
  return new ConflictException(msg('sessions.studentBusy', { name, title: clash.title }));
}

/** Refuses a time that overlaps another open session of the teacher or of any student. */
export async function assertFree(db: Db, tenantId: string, people: People, range: TimeRange, excludeSessionId?: string) {
  const [clash] = await findClashes(db, tenantId, people, [range], excludeSessionId);
  if (clash) throw clashError(clash, people.teacherId);
}

/**
 * Inside a transaction: holds a lock per person until it commits, so two requests booking the
 * same teacher or student can't both pass the clash check. Locked in a fixed order (no deadlocks).
 */
export async function lockPeople(tx: Db, people: People) {
  const ids = [...new Set([people.teacherId, ...people.studentIds])].sort();
  for (const id of ids) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`session-booking:${id}`}))`;
  }
}
