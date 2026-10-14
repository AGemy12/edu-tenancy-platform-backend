import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import { type MessageKey, type MessageParams, translate } from '../i18n/i18n.js';
import { DEFAULT_LOCALE, type Locale } from '../i18n/locale.js';

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
  async sendWelcome(
    p: { to: string; fullName: string; tenant: string; role: 'TEACHER' | 'STUDENT'; url: string | null; loginUrl: string; days: number },
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
