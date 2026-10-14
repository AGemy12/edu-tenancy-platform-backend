import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { parseLocale, type Locale } from './locale.js';

type RequestWithHeaders = { headers?: Record<string, string | string[] | undefined> };

export function requestLocale(req: RequestWithHeaders | undefined): Locale {
  return parseLocale(req?.headers?.['accept-language']);
}

/** Injects the request's locale (from `Accept-Language`, default Arabic). */
export const Lang = createParamDecorator((_data: unknown, ctx: ExecutionContext): Locale =>
  requestLocale(ctx.switchToHttp().getRequest<RequestWithHeaders>()),
);
