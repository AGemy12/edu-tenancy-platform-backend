import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import { msg } from '../i18n/i18n.js';
import { TokenCipher } from './token-cipher.js';
import { ZoomOAuthService } from './zoom-oauth.service.js';

const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'openid', 'email'].join(' ');

/**
 * Google OAuth connect flow for teachers so Google Meet sessions can be
 * created on their calendar. Zoom has its own flow in ZoomOAuthService.
 */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly cipher: TokenCipher,
    private readonly zoom: ZoomOAuthService,
  ) {}

  async status(user: JwtUser) {
    const rows = await this.prisma.integration.findMany({
      where: { userId: user.id },
      select: { provider: true, externalId: true, externalEmail: true, updatedAt: true },
    });
    const google = rows.find((r) => r.provider === 'GOOGLE');
    const zoom = rows.find((r) => r.provider === 'ZOOM');
    return {
      google: {
        configured: Boolean(this.config.get('GOOGLE_CLIENT_ID')),
        account: google ? { email: google.externalEmail ?? google.externalId, connectedAt: google.updatedAt } : null,
      },
      zoom: {
        configured: this.zoom.configured,
        account: zoom ? { email: zoom.externalEmail, connectedAt: zoom.updatedAt } : null,
      },
    };
  }

  /** Builds the Google consent URL. `state` is a short-lived JWT bound to the user. */
  async googleAuthUrl(user: JwtUser) {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!clientId) throw new ServiceUnavailableException(msg('integrations.googleDisabled'));
    const state = await this.jwt.signAsync(
      { sub: user.id, tenantId: user.tenantId, purpose: 'google-oauth' },
      { secret: this.config.getOrThrow('JWT_ACCESS_SECRET'), expiresIn: '10m' },
    );
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.config.getOrThrow('GOOGLE_REDIRECT_URI'),
      response_type: 'code',
      scope: GOOGLE_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
  }

  async googleCallback(code: string, state: string) {
    let payload: { sub: string; tenantId: string; purpose: string };
    try {
      payload = await this.jwt.verifyAsync(state, { secret: this.config.getOrThrow('JWT_ACCESS_SECRET') });
    } catch {
      throw new BadRequestException(msg('integrations.invalidState'));
    }
    if (payload.purpose !== 'google-oauth') throw new BadRequestException(msg('integrations.invalidState'));

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.getOrThrow('GOOGLE_CLIENT_ID'),
        client_secret: this.config.getOrThrow('GOOGLE_CLIENT_SECRET'),
        redirect_uri: this.config.getOrThrow('GOOGLE_REDIRECT_URI'),
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) {
      this.logger.error(`Google token exchange failed: ${res.status} ${await res.text()}`);
      throw new BadRequestException(msg('integrations.googleLinkFailed'));
    }
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
      id_token?: string;
    };

    const externalId = data.id_token ? this.emailFromIdToken(data.id_token) : null;

    await this.prisma.integration.upsert({
      where: { userId_provider: { userId: payload.sub, provider: 'GOOGLE' } },
      update: {
        accessToken: this.cipher.seal(data.access_token),
        refreshToken: this.cipher.seal(data.refresh_token) ?? undefined,
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
        scope: data.scope,
        externalId: externalId ?? undefined,
        externalEmail: externalId ?? undefined,
      },
      create: {
        tenantId: payload.tenantId,
        userId: payload.sub,
        provider: 'GOOGLE',
        accessToken: this.cipher.seal(data.access_token),
        refreshToken: this.cipher.seal(data.refresh_token),
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
        scope: data.scope,
        externalId,
        externalEmail: externalId,
      },
    });
  }

  async disconnectGoogle(user: JwtUser) {
    await this.prisma.integration.deleteMany({ where: { userId: user.id, provider: 'GOOGLE' } });
  }

  private emailFromIdToken(idToken: string): string | null {
    try {
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
      return typeof payload.email === 'string' ? payload.email : null;
    } catch {
      return null;
    }
  }
}
