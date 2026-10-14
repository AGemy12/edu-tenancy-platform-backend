import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { STATUS_CODES } from 'node:http';
import { isLocalizedMessage, isMessageKey, type MessageKey, translate } from './i18n.js';
import type { Locale } from './locale.js';
import { requestLocale } from './lang.decorator.js';

/**
 * Framework-generated messages (English) that we map to a dictionary key so
 * they also follow the request language.
 */
function fallbackKey(status: number, message: string): MessageKey | null {
  if (status === HttpStatus.PAYLOAD_TOO_LARGE) return 'library.fileTooLarge'; // multer "File too large"
  if (status === HttpStatus.UNAUTHORIZED && message === 'Unauthorized') return 'auth.unauthorized';
  if (status === HttpStatus.FORBIDDEN && message === 'Forbidden') return 'auth.forbidden';
  return null;
}

function localizeString(value: string, status: number, locale: Locale): string {
  if (isMessageKey(value)) return translate(locale, value);
  const fallback = fallbackKey(status, value);
  return fallback ? translate(locale, fallback) : value;
}

/**
 * Turns an `HttpException#getResponse()` value into the Nest-style error body
 * `{ statusCode, message, error }`, translating message keys into `locale`.
 * Strings that are not keys pass through untouched.
 */
export function localizeErrorBody(response: unknown, status: number, locale: Locale): unknown {
  const error = STATUS_CODES[status] ?? 'Error';

  if (isLocalizedMessage(response)) {
    return { statusCode: status, message: translate(locale, response.i18n, response.params), error };
  }
  if (typeof response === 'string') {
    return { statusCode: status, message: localizeString(response, status, locale), error };
  }
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const body = response as Record<string, unknown>;
    const { message } = body;
    const base = { ...body, statusCode: status, error: typeof body.error === 'string' ? body.error : error };
    if (typeof message === 'string') {
      return { ...base, message: localizeString(message, status, locale) };
    }
    if (Array.isArray(message)) {
      // ValidationPipe: DTO `message:` options carry keys, built-in messages stay as is.
      const localized = message.map((m) => (typeof m === 'string' && isMessageKey(m) ? translate(locale, m) : m));
      return { ...base, message: localized };
    }
  }
  return response;
}

/**
 * Localizes every `HttpException` body using the request's `Accept-Language`.
 * Other errors are not caught here, so Nest's default handler still logs them
 * and answers with a generic 500.
 */
@Catch(HttpException)
@Injectable()
export class I18nExceptionFilter implements ExceptionFilter<HttpException> {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: HttpException, host: ArgumentsHost) {
    const { httpAdapter } = this.adapterHost;
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<unknown>();
    if (httpAdapter.isHeadersSent(res)) {
      httpAdapter.end(res);
      return;
    }
    const status = exception.getStatus();
    const body = localizeErrorBody(exception.getResponse(), status, requestLocale(ctx.getRequest()));
    httpAdapter.reply(res, body, status);
  }
}
