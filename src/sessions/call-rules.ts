import type { CallStatus, Role, SessionStatus } from '../generated/prisma/enums.js';
import { EARLY_ENTRY_MIN, RECONNECT_GRACE_MIN } from './session-lifecycle.js';

/**
 * Calls from a teacher–student chat. Pure rules (unit-tested); CallsService loads the facts.
 *
 * A teacher and their student can call each other from their direct chat while one of their
 * one-to-one sessions is on: from EARLY_ENTRY_MIN before it starts until RECONNECT_GRACE_MIN after
 * its planned end. Every call belongs to that session (attendance, billing), and each has its own
 * meeting, so when one drops the next call starts clean while the chat stays as it was.
 *
 *   RINGING ──the other side joins──▶ ACTIVE ──meeting ended / hung up──▶ ENDED
 *      └──declined, called off, meeting ended, or rang RING_MS──▶ MISSED
 */

/** A call nobody picked up within this long counts as missed. */
export const RING_MS = 2 * 60_000;

const MIN = 60_000;

/** One teacher and one of their students, whichever placed the call. */
export type CallPair = { teacherMembershipId: string; studentMembershipId: string; teacherId: string; studentId: string };

type Party = { membershipId: string; role: Role; teacherId: string | null; studentId: string | null };

/** The teacher and the student of a direct chat, or null when the chat isn't between the two. */
export function callPair(a: Party, b: Party): CallPair | null {
  const teacher = [a, b].find((p) => p.role === 'TEACHER' && p.teacherId);
  const student = [a, b].find((p) => p.role === 'STUDENT' && p.studentId);
  if (!teacher || !student) return null;
  return { teacherMembershipId: teacher.membershipId, studentMembershipId: student.membershipId, teacherId: teacher.teacherId!, studentId: student.studentId! };
}

type CallableSession = { status: SessionStatus; startAt: Date; endAt: Date };

/** Whether a call can be placed for this session now. */
export function callWindowOpen(s: CallableSession, now: Date) {
  if (s.status !== 'SCHEDULED' && s.status !== 'LIVE') return false;
  const t = now.getTime();
  return t >= s.startAt.getTime() - EARLY_ENTRY_MIN * MIN && t <= s.endAt.getTime() + RECONNECT_GRACE_MIN * MIN;
}

/** The session a call belongs to: the live one, else the earliest whose window is open. */
export function sessionForCall<T extends CallableSession>(sessions: T[], now: Date): T | null {
  const open = sessions.filter((s) => callWindowOpen(s, now)).sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  return open.find((s) => s.status === 'LIVE') ?? open[0] ?? null;
}

type CallFacts = { status: CallStatus; createdAt: Date };

/** The call's status as of `now`: a ring nobody answered in time is missed. */
export function callStatus(call: CallFacts, now = new Date()): CallStatus {
  return call.status === 'RINGING' && now.getTime() - call.createdAt.getTime() > RING_MS ? 'MISSED' : call.status;
}

/** Still to be joined: ringing or in progress. A new call is placed only when none is. */
export function isOpenCall(call: CallFacts, now = new Date()) {
  const status = callStatus(call, now);
  return status === 'RINGING' || status === 'ACTIVE';
}

/** Answering: the side that didn't place the call joins a ringing one. */
export function answers(call: CallFacts & { callerId: string }, membershipId: string, now = new Date()) {
  return call.callerId !== membershipId && callStatus(call, now) === 'RINGING';
}

/**
 * Hanging up, or the meeting ending: a ringing call is missed (declined, called off), one in
 * progress has ended. Null when it is already over.
 */
export function hangUpStatus(call: CallFacts, now = new Date()): CallStatus | null {
  const status = callStatus(call, now);
  if (status === 'RINGING') return 'MISSED';
  if (status === 'ACTIVE') return 'ENDED';
  return null;
}

export const callSelect = {
  id: true,
  sessionId: true,
  callerId: true,
  status: true,
  answeredAt: true,
  endedAt: true,
  createdAt: true,
} as const;

type CallRow = { id: string; sessionId: string; callerId: string; status: CallStatus; answeredAt: Date | null; endedAt: Date | null; createdAt: Date };

/** The API shape of a call (never its link: that is handed out by `join`, which records attendance). */
export function presentCall(c: CallRow, now = new Date()) {
  return {
    id: c.id,
    sessionId: c.sessionId,
    callerId: c.callerId,
    status: callStatus(c, now),
    answeredAt: c.answeredAt,
    endedAt: c.endedAt,
    createdAt: c.createdAt,
  };
}
