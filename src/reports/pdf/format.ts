import type { Locale } from '../../i18n/locale.js';
import { translate, type MessageKey, type MessageParams } from '../../i18n/i18n.js';

type PdfKey = MessageKey extends infer K ? (K extends `pdf.${infer R}` ? R : never) : never;

/** Text and number formatting for one PDF: the reader's language and the center's time zone. */
export function formatter(locale: Locale, timeZone: string) {
  // Same tags as the web app: Arabic keeps Latin digits.
  const tag = locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US';
  const number = new Intl.NumberFormat(tag, { maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 0 });
  const date = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric', timeZone });
  const dateLong = new Intl.DateTimeFormat(tag, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone });
  const dayShort = new Intl.DateTimeFormat(tag, { weekday: 'short', day: 'numeric', month: 'short', timeZone });
  const time = new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit', timeZone });
  const dateTime = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short', timeZone });
  // Calendar days ("2026-10-01") are written as they are, so they're read at UTC.
  const day = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const dayMonth = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const month = new Intl.DateTimeFormat(tag, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const weekday = new Intl.DateTimeFormat(tag, { weekday: 'short', timeZone: 'UTC' });
  const list = new Intl.ListFormat(tag, { type: 'conjunction' });
  const utcDay = (d: string) => new Date(`${d}T00:00:00Z`);

  const t = (key: PdfKey, params?: MessageParams) => translate(locale, `pdf.${key}` as MessageKey, params);

  return {
    locale,
    dir: locale === 'ar' ? 'rtl' : 'ltr',
    t,
    number: (n: number) => number.format(n),
    percent: (n: number | null) => (n === null ? '—' : percent.format(n)),
    /** A 0..100 score. */
    score: (n: number | null) => (n === null ? '—' : `${number.format(Math.round(n))}%`),
    rating: (n: number | null) => (n === null ? '—' : t('ratingValue', { rating: number.format(n) })),
    date: (d: Date | string) => date.format(new Date(d)),
    dateLong: (d: Date | string) => dateLong.format(new Date(d)),
    dayShort: (d: Date | string) => dayShort.format(new Date(d)),
    time: (d: Date | string) => time.format(new Date(d)),
    dateTime: (d: Date | string) => dateTime.format(new Date(d)),
    day: (d: string) => day.format(utcDay(d)),
    dayMonth: (d: string) => dayMonth.format(utcDay(d)),
    month: (ym: string) => month.format(utcDay(`${ym.slice(0, 7)}-01`)),
    weekday: (d: string) => weekday.format(utcDay(d)),
    list: (xs: string[]) => list.format(xs),
    /** "2 h 30 min" */
    duration: (minutes: number) => {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      if (!h) return t('minutes', { m: number.format(m) });
      return m ? t('hoursMinutes', { h: number.format(h), m: number.format(m) }) : t('hours', { h: number.format(h) });
    },
    money: (n: number, currency: string) => new Intl.NumberFormat(tag, { style: 'currency', currency, maximumFractionDigits: 2 }).format(n),
    period: (from: string, to: string) => (from === to ? day.format(utcDay(from)) : t('periodRange', { from: day.format(utcDay(from)), to: day.format(utcDay(to)) })),
  };
}

export type Fmt = ReturnType<typeof formatter>;
