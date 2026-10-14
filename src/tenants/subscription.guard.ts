import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import { msg } from '../i18n/i18n.js';
import { isExpired } from './subscription.js';

const ALLOW_EXPIRED_KEY = 'allowExpired';
/** Lets a write through for centers whose subscription has lapsed (signing out, changing a password). */
export const AllowExpired = () => SetMetadata(ALLOW_EXPIRED_KEY, true);

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CACHE_MS = 60_000;

/** Whether a tenant's subscription has lapsed, cached briefly so the guard doesn't hit the DB on every write. */
@Injectable()
export class SubscriptionAccess {
  private readonly cache = new Map<string, { expired: boolean; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async expired(tenantId: string) {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.expired;
    const sub = await this.prisma.subscription.findUnique({
      where: { tenantId },
      select: { status: true, currentPeriodEnd: true },
    });
    const expired = isExpired(sub);
    this.cache.set(tenantId, { expired, at: Date.now() });
    return expired;
  }

  /** Call after changing a tenant's subscription. */
  forget(tenantId: string) {
    this.cache.delete(tenantId);
  }
}

/** Runs after the auth and role guards: refuses writes from centers whose subscription has lapsed. */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: SubscriptionAccess,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<{ method: string; user?: JwtUser }>();
    const user = req.user;
    if (!user?.tenantId || user.role === 'SUPER_ADMIN' || READS.has(req.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_EXPIRED_KEY, [ctx.getHandler(), ctx.getClass()])) return true;
    if (await this.access.expired(user.tenantId)) {
      throw new HttpException(msg('subscription.expired'), HttpStatus.PAYMENT_REQUIRED);
    }
    return true;
  }
}
