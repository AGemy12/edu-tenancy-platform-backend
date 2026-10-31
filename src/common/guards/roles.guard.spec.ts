import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard.js';
import type { JwtUser } from '../decorators/current-user.decorator.js';

const user = (role: JwtUser['role'], tenantId: string | null = 't1') =>
  ({ id: 'u', email: 'u@x.test', role, status: 'ACTIVE', tenantId, teacherId: null, studentId: null, membershipId: tenantId && 'm1' }) as JwtUser;
const ctx = (u?: JwtUser) => ({ switchToHttp: () => ({ getRequest: () => ({ user: u }) }), getHandler: () => null, getClass: () => null }) as unknown as ExecutionContext;
const guard = (roles?: string[]) => new RolesGuard({ getAllAndOverride: () => roles } as unknown as Reflector);

describe('RolesGuard', () => {
  it('lets anyone through a route without roles', () => {
    expect(guard().canActivate(ctx(user('STUDENT')))).toBe(true);
  });

  it('checks center roles', () => {
    expect(guard(['TENANT_ADMIN', 'TEACHER']).canActivate(ctx(user('TEACHER')))).toBe(true);
    expect(() => guard(['TENANT_ADMIN']).canActivate(ctx(user('STUDENT')))).toThrow(ForbiddenException);
  });

  it("keeps the platform console (no center) to platform routes, so center routes don't fail on a missing center", () => {
    const console = user('SUPER_ADMIN', null);
    expect(guard(['SUPER_ADMIN']).canActivate(ctx(console))).toBe(true);
    expect(() => guard(['TENANT_ADMIN', 'TEACHER']).canActivate(ctx(console))).toThrow(ForbiddenException);
  });
});
