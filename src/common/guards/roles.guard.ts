import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '../../generated/prisma/client.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import type { JwtUser } from '../decorators/current-user.decorator.js';
import { msg } from '../../i18n/i18n.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const { user } = ctx.switchToHttp().getRequest<{ user?: JwtUser }>();
    if (!user) throw new ForbiddenException(msg('auth.forbidden'));
    // The platform console has no center: it passes any role check, but center routes need a
    // center (a 403 here, instead of a service failing on a missing tenantId).
    if (user.role === 'SUPER_ADMIN') {
      if (user.tenantId || required.includes('SUPER_ADMIN')) return true;
      throw new ForbiddenException(msg('auth.forbidden'));
    }
    if (!required.includes(user.role)) {
      throw new ForbiddenException(msg('auth.forbidden'));
    }
    return true;
  }
}
