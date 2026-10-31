import type { AccountStatus, ConversationKind, MessageKind, Role } from '../generated/prisma/enums.js';

/**
 * Who may talk to whom inside a center, and what a member may do to a message. Pure rules
 * (unit-tested); the service loads the facts and asks.
 *
 * Direct messages follow the center's structure:
 * - the center's admins can message, and be messaged by, anyone in the center;
 * - teachers can message each other;
 * - a teacher and a student can message each other when the student is theirs (a TeacherStudent
 *   link or an active enrollment in one of the teacher's courses);
 * - students never message other students directly (safeguarding: a center can't see private
 *   chats, so students meet only in groups a teacher or admin runs).
 * Blocked members can't be reached at all.
 */

export type ChatMember = {
  membershipId: string;
  role: Role;
  status: AccountStatus;
  teacherId: string | null;
  studentId: string | null;
};

/** Whether `teacherId` teaches `studentId` (linked, or enrolled in one of their courses). */
export type TeachesFn = (teacherId: string, studentId: string) => boolean;

export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_GROUP_TITLE = 80;
export const MAX_GROUP_MEMBERS = 500;
/** A message can be edited for this long after it was sent. */
export const EDIT_WINDOW_MS = 15 * 60_000;

export function canMessage(from: ChatMember, to: ChatMember, teaches: TeachesFn): boolean {
  if (from.membershipId === to.membershipId || to.status === 'BLOCKED') return false;
  if (from.role === 'TENANT_ADMIN' || to.role === 'TENANT_ADMIN') return true;
  if (from.role === 'TEACHER' && to.role === 'TEACHER') return true;
  if (from.role === 'TEACHER' && to.role === 'STUDENT') return Boolean(from.teacherId && to.studentId && teaches(from.teacherId, to.studentId));
  if (from.role === 'STUDENT' && to.role === 'TEACHER') return Boolean(to.teacherId && from.studentId && teaches(to.teacherId, from.studentId));
  return false;
}

/** Admins and teachers run groups; students join them. */
export function canCreateGroup(role: Role) {
  return role === 'TENANT_ADMIN' || role === 'TEACHER';
}

/** One conversation per pair, whoever starts it. */
export function directKey(a: string, b: string) {
  return [a, b].sort().join(':');
}

export function canPost(conversation: { kind: ConversationKind; adminsOnly: boolean }, participant: { isAdmin: boolean }) {
  return conversation.kind === 'DIRECT' || !conversation.adminsOnly || participant.isAdmin;
}

type MessageFacts = { senderId: string | null; kind: MessageKind; deletedAt: Date | null; createdAt: Date };

/** Only the sender edits, only text, only shortly after sending (the others may have read it). */
export function canEdit(message: MessageFacts, membershipId: string, now = new Date()) {
  return (
    message.kind === 'TEXT' &&
    !message.deletedAt &&
    message.senderId === membershipId &&
    now.getTime() - message.createdAt.getTime() <= EDIT_WINDOW_MS
  );
}

/** The sender deletes their own message; a group's admins moderate theirs. */
export function canDelete(message: MessageFacts, membershipId: string, conversation: { kind: ConversationKind }, participant: { isAdmin: boolean }) {
  if (message.kind !== 'TEXT' || message.deletedAt) return false;
  if (message.senderId === membershipId) return true;
  return conversation.kind === 'GROUP' && participant.isAdmin;
}

/** Trims, and refuses empty or over-long text. */
export function cleanBody(body: string): string | null {
  const text = body.replace(/\r\n/g, '\n').trim();
  return text && text.length <= MAX_MESSAGE_LENGTH ? text : null;
}
