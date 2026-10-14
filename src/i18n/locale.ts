export type Locale = 'ar' | 'en';

export const LOCALES: readonly Locale[] = ['ar', 'en'];
export const DEFAULT_LOCALE: Locale = 'ar';

/**
 * Picks the best supported locale from an `Accept-Language` header value
 * (e.g. `en-US,en;q=0.9,ar;q=0.8`). Region subtags are ignored, q-values are
 * honoured (q=0 means "not acceptable"), ties keep header order, and anything
 * unrecognised falls back to Arabic.
 */
export function parseLocale(header?: string | string[]): Locale {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return DEFAULT_LOCALE;

  let best: { locale: Locale; q: number } | null = null;
  for (const part of value.split(',')) {
    const [rawTag, ...rawParams] = part.trim().split(';');
    const primary = rawTag.trim().toLowerCase().split('-')[0];
    if (!isLocale(primary)) continue;

    let q = 1;
    for (const param of rawParams) {
      const [name, raw] = param.trim().split('=');
      if (name?.trim().toLowerCase() !== 'q') continue;
      const parsed = Number(raw);
      q = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
    }
    if (q > 0 && (!best || q > best.q)) best = { locale: primary, q };
  }
  return best?.locale ?? DEFAULT_LOCALE;
}

export function isLocale(value: unknown): value is Locale {
  return value === 'ar' || value === 'en';
}
