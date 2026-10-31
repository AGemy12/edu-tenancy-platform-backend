import { type ChatMember, EDIT_WINDOW_MS, canCreateGroup, canDelete, canEdit, canMessage, canPost, cleanBody, directKey } from './messaging-rules.js';

const member = (membershipId: string, role: ChatMember['role'], extra: Partial<ChatMember> = {}): ChatMember => ({
  membershipId,
  role,
  status: 'ACTIVE',
  teacherId: role === 'TEACHER' ? `t-${membershipId}` : null,
  studentId: role === 'STUDENT' ? `s-${membershipId}` : null,
  ...extra,
});

const admin = member('a', 'TENANT_ADMIN');
const teacher = member('t1', 'TEACHER');
const otherTeacher = member('t2', 'TEACHER');
const student = member('s1', 'STUDENT');
const otherStudent = member('s2', 'STUDENT');
// t1 teaches s1 only.
const teaches = (teacherId: string, studentId: string) => teacherId === 't-t1' && studentId === 's-s1';

describe('canMessage', () => {
  it('lets admins reach anyone, and anyone reach the admins', () => {
    for (const m of [teacher, student, otherStudent]) {
      expect(canMessage(admin, m, teaches)).toBe(true);
      expect(canMessage(m, admin, teaches)).toBe(true);
    }
  });

  it('lets teachers talk to each other', () => {
    expect(canMessage(teacher, otherTeacher, teaches)).toBe(true);
  });

  it('pairs a teacher and a student only when the student is theirs', () => {
    expect(canMessage(teacher, student, teaches)).toBe(true);
    expect(canMessage(student, teacher, teaches)).toBe(true);
    expect(canMessage(otherTeacher, student, teaches)).toBe(false);
    expect(canMessage(otherStudent, teacher, teaches)).toBe(false);
  });

  it('never lets students message each other, nor anyone message themselves or a blocked member', () => {
    expect(canMessage(student, otherStudent, teaches)).toBe(false);
    expect(canMessage(admin, admin, teaches)).toBe(false);
    expect(canMessage(admin, member('x', 'TEACHER', { status: 'BLOCKED' }), teaches)).toBe(false);
  });

  it('lets an admin who also teaches be reached by anyone', () => {
    expect(canMessage(otherStudent, member('a2', 'TENANT_ADMIN', { teacherId: 't-a2' }), teaches)).toBe(true);
  });
});

describe('groups and posting', () => {
  it('lets admins and teachers create groups', () => {
    expect(canCreateGroup('TENANT_ADMIN')).toBe(true);
    expect(canCreateGroup('TEACHER')).toBe(true);
    expect(canCreateGroup('STUDENT')).toBe(false);
  });

  it('keeps announcement groups to their admins', () => {
    expect(canPost({ kind: 'GROUP', adminsOnly: true }, { isAdmin: false })).toBe(false);
    expect(canPost({ kind: 'GROUP', adminsOnly: true }, { isAdmin: true })).toBe(true);
    expect(canPost({ kind: 'GROUP', adminsOnly: false }, { isAdmin: false })).toBe(true);
    expect(canPost({ kind: 'DIRECT', adminsOnly: false }, { isAdmin: false })).toBe(true);
  });

  it('gives a pair the same key whoever starts', () => {
    expect(directKey('b', 'a')).toBe(directKey('a', 'b'));
  });
});

describe('editing and deleting', () => {
  const sent = new Date('2026-10-20T10:00:00Z');
  const msg = { senderId: 'me', kind: 'TEXT' as const, deletedAt: null, createdAt: sent };

  it('lets the sender edit within the window only', () => {
    expect(canEdit(msg, 'me', new Date(sent.getTime() + EDIT_WINDOW_MS))).toBe(true);
    expect(canEdit(msg, 'me', new Date(sent.getTime() + EDIT_WINDOW_MS + 1))).toBe(false);
    expect(canEdit(msg, 'other', sent)).toBe(false);
    expect(canEdit({ ...msg, kind: 'SYSTEM' }, 'me', sent)).toBe(false);
    expect(canEdit({ ...msg, deletedAt: sent }, 'me', sent)).toBe(false);
  });

  it('lets the sender delete, and group admins moderate', () => {
    expect(canDelete(msg, 'me', { kind: 'DIRECT' }, { isAdmin: false })).toBe(true);
    expect(canDelete(msg, 'other', { kind: 'DIRECT' }, { isAdmin: true })).toBe(false);
    expect(canDelete(msg, 'other', { kind: 'GROUP' }, { isAdmin: true })).toBe(true);
    expect(canDelete(msg, 'other', { kind: 'GROUP' }, { isAdmin: false })).toBe(false);
    expect(canDelete({ ...msg, kind: 'SYSTEM' }, 'me', { kind: 'GROUP' }, { isAdmin: true })).toBe(false);
  });

  it('cleans message text', () => {
    expect(cleanBody('  hi\r\nthere  ')).toBe('hi\nthere');
    expect(cleanBody('   ')).toBeNull();
    expect(cleanBody('x'.repeat(4001))).toBeNull();
  });
});
