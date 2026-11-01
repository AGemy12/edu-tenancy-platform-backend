import type { SessionStatus } from '../generated/prisma/enums.js';
import { RING_MS } from './call-rules.js';

/**
 * The "incoming call" a student gets when their session starts. Pure rules (unit-tested);
 * SessionsService loads the facts.
 *
 * A live session calls each of its students who hasn't entered yet. It rings for RING_MS from the
 * moment the meeting opened, then stays as a "join now" banner until the student enters, the
 * session ends or its meeting drops. Nothing is stored: "later" is the student's device's choice,
 * never an absence.
 */

type RingFacts = { status: SessionStatus; startedAt: Date | null; endedAt: Date | null; attended: boolean };

/** Whether this session is calling the student: live, its meeting up, and they haven't entered. */
export function callsStudent(s: RingFacts) {
  return s.status === 'LIVE' && !s.endedAt && !s.attended;
}

/** The session calling the student: the most recently started (a student is rarely in two at once). */
export function sessionCalling<T extends RingFacts>(sessions: T[]): T | null {
  const calling = sessions.filter(callsStudent);
  calling.sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
  return calling[0] ?? null;
}

/** How much longer it rings, in ms; 0 once it has turned into the banner. */
export function ringLeftMs(startedAt: Date | null, now: Date) {
  if (!startedAt) return 0;
  return Math.max(0, RING_MS - (now.getTime() - startedAt.getTime()));
}
