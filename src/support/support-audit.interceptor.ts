import { type CallHandler, type ExecutionContext, HttpException, Injectable, Logger, type NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { catchError, tap, throwError } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SKIP_AUDIT_KEY = 'skipSupportAudit';

/** A write that changes nothing in the center (such as leaving support mode), kept out of the log. */
export const SkipSupportAudit = () => SetMetadata(SKIP_AUDIT_KEY, true);

/** Keeps every write made in support mode (method, path, outcome), so the center's history shows what support did. */
@Injectable()
export class SupportAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(SupportAuditInterceptor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler) {
    const http = ctx.switchToHttp();
    const req = http.getRequest<{ method: string; originalUrl: string; user?: JwtUser }>();
    const sessionId = req.user?.supportSessionId;
    if (!sessionId || READS.has(req.method)) return next.handle();
    if (this.reflector.getAllAndOverride<boolean>(SKIP_AUDIT_KEY, [ctx.getHandler(), ctx.getClass()])) return next.handle();

    const path = req.originalUrl.split('?')[0];
    const record = (status: number) => {
      this.prisma.supportAction
        .create({ data: { sessionId, method: req.method, path, status } })
        .catch((err: unknown) => this.logger.warn(`Support action not recorded: ${String(err)}`));
    };
    return next.handle().pipe(
      tap(() => record(http.getResponse<{ statusCode: number }>().statusCode)),
      catchError((err: unknown) => {
        record(err instanceof HttpException ? err.getStatus() : 500);
        return throwError(() => err);
      }),
    );
  }
}
