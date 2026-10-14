import type { Locale } from './locale.js';
import { messages, type MessageKey } from './messages.js';

export type { MessageKey } from './messages.js';

export type MessageParams = Record<string, string | number>;

/** Exception payload resolved to text by `I18nExceptionFilter` in the request's language. */
export type LocalizedMessage = { i18n: MessageKey; params?: MessageParams };

/**
 * Builds a localized exception payload:
 * `throw new NotFoundException(msg('students.notFound'))`.
 *
 * The key is also attached as a non-enumerable `message`, so `HttpException`
 * reports it as `err.message` in logs without it leaking into the JSON body.
 */
export function msg(key: MessageKey, params?: MessageParams): LocalizedMessage {
  const payload: LocalizedMessage = params ? { i18n: key, params } : { i18n: key };
  Object.defineProperty(payload, 'message', { value: key, enumerable: false });
  return payload;
}

export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const template = messages[locale][key] ?? messages.ar[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

export function isMessageKey(value: unknown): value is MessageKey {
  return typeof value === 'string' && Object.hasOwn(messages.ar, value);
}

export function isLocalizedMessage(value: unknown): value is LocalizedMessage {
  return typeof value === 'object' && value !== null && isMessageKey((value as { i18n?: unknown }).i18n);
}
