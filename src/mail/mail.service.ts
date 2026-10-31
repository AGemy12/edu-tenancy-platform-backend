import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import { type MessageKey, type MessageParams, isMessageKey, translate } from '../i18n/i18n.js';
import { DEFAULT_LOCALE, type Locale } from '../i18n/locale.js';
import type { NotificationType } from '../generated/prisma/enums.js';
import { templateOf } from '../notifications/notification-catalog.js';

export type MailMessage = { to: string; subject: string; html: string; text?: string };

/**
 * Sends email through SMTP when configured; otherwise logs the message so the
 * flow still works in development (reset links show up in the API console).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const host = config.get<string>('SMTP_HOST');
    this.from = config.get<string>('MAIL_FROM') ?? 'no-reply@edu-platform.local';
    this.transporter = host
      ? nodemailer.createTransport({
          host,
          port: Number(config.get('SMTP_PORT') ?? 587),
          secure: config.get('SMTP_SECURE') === 'true',
          auth: config.get('SMTP_USER')
            ? { user: config.get<string>('SMTP_USER'), pass: config.get<string>('SMTP_PASS') }
            : undefined,
        })
      : null;
  }

  get configured() {
    return this.transporter !== null;
  }

  async send(msg: MailMessage): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(`SMTP not configured — email to ${msg.to} not sent.\nSubject: ${msg.subject}\n${msg.text ?? msg.html}`);
      return;
    }
    await this.transporter.sendMail({ from: this.from, ...msg });
    this.logger.log(`Email sent to ${msg.to}: ${msg.subject}`);
  }

  async sendPasswordReset(
    to: string,
    fullName: string,
    resetUrl: string,
    expiresMinutes: number,
    locale: Locale = DEFAULT_LOCALE,
  ) {
    const t = (key: MessageKey, params?: MessageParams) => translate(locale, key, params);
    const dir = locale === 'ar' ? 'rtl' : 'ltr';
    const url = escapeHtml(resetUrl);

    const text = [
      t('mail.reset.greeting', { name: fullName }),
      '',
      t('mail.reset.textBody', { minutes: expiresMinutes }),
      resetUrl,
      '',
      t('mail.reset.textIgnore'),
    ].join('\n');
    const html = `
      <div dir="${dir}" lang="${locale}" style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:24px;color:#0b2b2a">
        <h2 style="margin:0 0 12px">${t('mail.reset.heading')}</h2>
        <p>${t('mail.reset.greeting', { name: escapeHtml(fullName) })}</p>
        <p>${t('mail.reset.body', { minutes: expiresMinutes })}</p>
        <p style="margin:24px 0">
          <a href="${url}" style="background:#0f766e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;display:inline-block">${t('mail.reset.button')}</a>
        </p>
        <p style="color:#5f7a77;font-size:13px">${t('mail.reset.ignore')}</p>
        <p style="color:#5f7a77;font-size:12px;direction:ltr;text-align:left;word-break:break-all">${url}</p>
      </div>`;
    await this.send({ to, subject: t('mail.reset.subject'), html, text });
  }

  /**
   * A teacher or student was added to a center. A brand-new account gets a link to choose a
   * password (`url`); someone who already had an account (`url: null`) is told to sign in as usual.
   */
  /** Tells a center's admin that platform support asks to come in, and where to approve or deny it. */
  async sendSupportRequest(
    p: { to: string; fullName: string; tenant: string; actor: string; target: string; role: 'TENANT_ADMIN' | 'TEACHER' | 'STUDENT'; reason: string; url: string; hours: number },
    locale: Locale = DEFAULT_LOCALE,
  ) {
    const t = (key: MessageKey, params?: MessageParams) => translate(locale, key, params);
    const dir = locale === 'ar' ? 'rtl' : 'ltr';
    const role = t(`mail.welcome.role.${p.role}`);
    const url = escapeHtml(p.url);
    const text = [
      t('mail.support.greeting', { name: p.fullName }),
      '',
      t('mail.support.body', { actor: p.actor, tenant: p.tenant, target: p.target, role }),
      t('mail.support.reason', { reason: p.reason }),
      '',
      t('mail.support.note', { hours: p.hours }),
      '',
      t('mail.support.textBody'),
      p.url,
    ].join('\n');
    const html = `
      <div dir="${dir}" lang="${locale}" style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:24px;color:#0b2b2a">
        <h2 style="margin:0 0 12px">${t('mail.support.heading')}</h2>
        <p>${t('mail.support.greeting', { name: escapeHtml(p.fullName) })}</p>
        <p>${t('mail.support.body', { actor: escapeHtml(p.actor), tenant: escapeHtml(p.tenant), target: escapeHtml(p.target), role })}</p>
        <p style="background:#f1f8f7;border-radius:12px;padding:12px 16px">${t('mail.support.reason', { reason: escapeHtml(p.reason) })}</p>
        <p style="margin:24px 0">
          <a href="${url}" style="background:#0f766e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;display:inline-block">${t('mail.support.button')}</a>
        </p>
        <p style="color:#5f7a77;font-size:13px">${t('mail.support.note', { hours: p.hours })}</p>
        <p style="color:#5f7a77;font-size:12px;direction:ltr;text-align:left;word-break:break-all">${url}</p>
      </div>`;
    await this.send({ to: p.to, subject: t('mail.support.subject', { tenant: p.tenant }), html, text });
  }

  /**
   * One notification as an email, from its type's `notify.<template>.title/body` messages.
   * ISO dates among the params are written out in the center's time zone; `<name>Ar`/`<name>En`
   * pairs (a package's name) become `<name>` in the recipient's language.
   */
  async sendNotification(
    p: { to: string; fullName: string; type: NotificationType; params: Record<string, string | number>; timezone: string; url: string; settingsUrl: string },
    locale: Locale = DEFAULT_LOCALE,
  ) {
    const template = templateOf(p.type, p.params);
    const titleKey = `notify.${template}.title`;
    const bodyKey = `notify.${template}.body`;
    if (!isMessageKey(titleKey) || !isMessageKey(bodyKey)) {
      this.logger.warn(`No email text for notification ${template}`);
      return;
    }
    const t = (key: MessageKey, params?: MessageParams) => translate(locale, key, params);
    const dir = locale === 'ar' ? 'rtl' : 'ltr';
    const values = localizedParams(p.params, locale, p.timezone);
    const escaped = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, escapeHtml(String(v))]));
    const title = t(titleKey, values);
    const url = escapeHtml(p.url);

    const reason = values.reason ? t('mail.notify.reason', { reason: values.reason }) : null;
    const text = [
      t('mail.notify.greeting', { name: p.fullName }),
      '',
      t(bodyKey, values),
      ...(reason ? [reason] : []),
      '',
      t('mail.notify.textLink'),
      p.url,
      '',
      t('mail.notify.footer'),
      p.settingsUrl,
    ].join('\n');
    const html = `
      <div dir="${dir}" lang="${locale}" style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:24px;color:#0b2b2a">
        <h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>
        <p>${t('mail.notify.greeting', { name: escapeHtml(p.fullName) })}</p>
        <p style="white-space:pre-line">${t(bodyKey, escaped)}</p>
        ${reason ? `<p style="background:#f1f8f7;border-radius:12px;padding:12px 16px">${t('mail.notify.reason', { reason: escaped.reason })}</p>` : ''}
        <p style="margin:24px 0">
          <a href="${url}" style="background:#0f766e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;display:inline-block">${t('mail.notify.button')}</a>
        </p>
        <p style="color:#5f7a77;font-size:12px">${t('mail.notify.footer')} <a href="${escapeHtml(p.settingsUrl)}" style="color:#0f766e">${t('mail.notify.settings')}</a></p>
      </div>`;
    await this.send({ to: p.to, subject: title, html, text });
  }

  async sendWelcome(
    p: { to: string; fullName: string; tenant: string; role: 'TENANT_ADMIN' | 'TEACHER' | 'STUDENT'; url: string | null; loginUrl: string; days: number },
    locale: Locale = DEFAULT_LOCALE,
  ) {
    const t = (key: MessageKey, params?: MessageParams) => translate(locale, key, params);
    const dir = locale === 'ar' ? 'rtl' : 'ltr';
    const role = t(`mail.welcome.role.${p.role}`);
    const fresh = p.url !== null;
    const link = fresh ? p.url! : p.loginUrl;
    const url = escapeHtml(link);
    const heading = fresh ? t('mail.welcome.heading') : t('mail.welcome.existingHeading');
    const body = fresh
      ? t('mail.welcome.body', { tenant: p.tenant, role, email: p.to })
      : t('mail.welcome.existingBody', { tenant: p.tenant, role, email: p.to });
    const note = fresh ? t('mail.welcome.linkNote', { days: p.days }) : t('mail.welcome.existingNote');

    const text = [
      t('mail.welcome.greeting', { name: p.fullName }),
      '',
      body,
      '',
      fresh ? t('mail.welcome.textBody', { days: p.days }) : t('mail.welcome.existingTextBody'),
      link,
    ].join('\n');
    const email = `<span dir="ltr">${escapeHtml(p.to)}</span>`;
    const htmlBody = fresh
      ? t('mail.welcome.body', { tenant: escapeHtml(p.tenant), role, email })
      : t('mail.welcome.existingBody', { tenant: escapeHtml(p.tenant), role, email });
    const html = `
      <div dir="${dir}" lang="${locale}" style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:24px;color:#0b2b2a">
        <h2 style="margin:0 0 12px">${heading}</h2>
        <p>${t('mail.welcome.greeting', { name: escapeHtml(p.fullName) })}</p>
        <p>${htmlBody}</p>
        <p style="margin:24px 0">
          <a href="${url}" style="background:#0f766e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;display:inline-block">${fresh ? t('mail.welcome.button') : t('mail.welcome.existingButton')}</a>
        </p>
        <p style="color:#5f7a77;font-size:13px">${note}</p>
        <p style="color:#5f7a77;font-size:12px;direction:ltr;text-align:left;word-break:break-all">${url}</p>
      </div>`;
    await this.send({ to: p.to, subject: t('mail.welcome.subject', { tenant: p.tenant }), html, text });
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Template values for one reader: moments ("2026-10-20T15:00:00Z") in their center's time zone,
 * calendar days ("2026-11-01") as written, and `xAr`/`xEn` pairs as `x` in their language.
 */
export function localizedParams(params: Record<string, string | number>, locale: Locale, timeZone: string): MessageParams {
  const out: MessageParams = {};
  const suffix = locale === 'ar' ? 'Ar' : 'En';
  // Same tags as the web app: Arabic keeps Latin digits.
  const tag = locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US';
  const dateTime = new Intl.DateTimeFormat(tag, { dateStyle: 'full', timeStyle: 'short', timeZone });
  const day = new Intl.DateTimeFormat(tag, { dateStyle: 'long', timeZone: 'UTC' });
  // Names and titles keep their own direction inside the sentence (Arabic in English, or the reverse).
  const isolate = (value: string | number) => (typeof value === 'string' ? `\u2068${value}\u2069` : value);
  for (const [key, value] of Object.entries(params)) {
    if (/[a-z](Ar|En)$/.test(key)) {
      if (key.endsWith(suffix)) out[key.slice(0, -2)] = isolate(value);
      continue;
    }
    if (typeof value === 'string' && ISO_DATE_TIME.test(value)) out[key] = dateTime.format(new Date(value));
    else if (typeof value === 'string' && ISO_DATE.test(value)) out[key] = day.format(new Date(`${value}T00:00:00Z`));
    else out[key] = isolate(value);
  }
  return out;
}
