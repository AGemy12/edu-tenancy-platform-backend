import { accountLock } from './member-account.js';

const editor = { id: 'admin', supportSessionId: undefined };
const student = { userId: 'u1', role: 'STUDENT' as const, centers: 1, isPlatformAdmin: false };

describe('accountLock', () => {
  it("lets the center change a teacher's or student's account that is only in this center", () => {
    expect(accountLock(student, editor)).toBeNull();
    expect(accountLock({ ...student, role: 'TEACHER' }, editor)).toBeNull();
  });

  it('leaves an account that is in other centers too, or a platform operator, to its owner', () => {
    expect(accountLock({ ...student, centers: 2 }, editor)).toBe('shared');
    expect(accountLock({ ...student, isPlatformAdmin: true }, editor)).toBe('shared');
  });

  it("sends the editor to their own settings for their own account, and leaves admins' accounts to them", () => {
    expect(accountLock({ ...student, userId: 'admin', role: 'TENANT_ADMIN' }, editor)).toBe('self');
    expect(accountLock({ ...student, role: 'TENANT_ADMIN' }, editor)).toBe('admin');
  });

  it('never changes how someone signs in from support mode', () => {
    expect(accountLock(student, { id: 'admin', supportSessionId: 's1' })).toBe('support');
  });
});
