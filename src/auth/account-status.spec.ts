import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccountStatusGuard, AllowSuspended } from './account-status.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';

const user = (status: JwtUser['status']): JwtUser => ({
  id: 'u1', email: 'x@test', role: 'TEACHER', status, tenantId: 't1', teacherId: 'tc1', studentId: null, membershipId: 'm1',
});

class Plain { write() {} }
class Allowed { @AllowSuspended() write() {} }

function ctx(method: string, u: JwtUser | undefined, handler: object = Plain.prototype.write, cls: object = Plain) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, user: u }) }),
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
}

describe('AccountStatusGuard', () => {
  const guard = new AccountStatusGuard(new Reflector());

  it('lets active members do anything', () => {
    expect(guard.canActivate(ctx('POST', user('ACTIVE')))).toBe(true);
  });

  it('lets suspended members read but not write', () => {
    expect(guard.canActivate(ctx('GET', user('SUSPENDED')))).toBe(true);
    expect(() => guard.canActivate(ctx('POST', user('SUSPENDED')))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx('PATCH', user('SUSPENDED')))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx('DELETE', user('SUSPENDED')))).toThrow(ForbiddenException);
  });

  it('lets suspended members through writes marked @AllowSuspended (their own profile, password, sign-out)', () => {
    expect(guard.canActivate(ctx('POST', user('SUSPENDED'), Allowed.prototype.write, Allowed))).toBe(true);
  });

  it('ignores public routes', () => {
    expect(guard.canActivate(ctx('POST', undefined))).toBe(true);
  });
});
