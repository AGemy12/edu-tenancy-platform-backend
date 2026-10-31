import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import { msg } from '../i18n/i18n.js';

const DENY_IN_SUPPORT_KEY = 'denyInSupport';

/**
 * Marks a route a platform admin may not use while working as a member (support mode): what
 * belongs to the person rather than the center, such as their password, sign-in email, linked
 * Zoom or Google account, or their other centers.
 */
export const DenyInSupport = () => SetMetadata(DENY_IN_SUPPORT_KEY, true);

@Injectable()
export class SupportGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<{ user?: JwtUser }>();
    if (!req.user?.supportSessionId) return true;
    if (this.reflector.getAllAndOverride<boolean>(DENY_IN_SUPPORT_KEY, [ctx.getHandler(), ctx.getClass()])) {
      throw new ForbiddenException(msg('support.notAllowed'));
    }
    return true;
  }
}
