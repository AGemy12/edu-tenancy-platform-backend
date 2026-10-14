import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import { TokenCipher } from './token-cipher.js';
import { msg } from '../i18n/i18n.js';

type TokenResponse = { access_token: string; refresh_token: string; expires_in: number; scope?: string };

/**
 * Per-user Zoom OAuth (a Zoom Marketplace "General app", user-managed). Each teacher connects
 * their own Zoom account, so meetings run on their licence and two teachers can be live at once.
 * Docs: https://developers.zoom.us/docs/integrations/oauth/
 */
@Injectable()
export class ZoomOAuthService {
  private readonly logger = new Logger(ZoomOAuthService.name);
  /** One refresh per user at a time: Zoom rotates the refresh token on every use. */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly cipher: TokenCipher,
  ) {}

  get configured() {
    return Boolean(
      this.config.get('ZOOM_CLIENT_ID') && this.config.get('ZOOM_CLIENT_SECRET') && this.config.get('ZOOM_REDIRECT_URI'),
    );
  }

  /** Builds the Zoom consent URL. `state` is a short-lived JWT bound to the user. */
  async authUrl(user: JwtUser) {
    if (!this.configured) throw new ServiceUnavailableException(msg('meetings.zoomDisabled'));
    const state = await this.jwt.signAsync(
      { sub: user.id, tenantId: user.tenantId, purpose: 'zoom-oauth' },
      { secret: this.config.getOrThrow('JWT_ACCESS_SECRET'), expiresIn: '10m' },
    );
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.getOrThrow('ZOOM_CLIENT_ID'),
      redirect_uri: this.config.getOrThrow('ZOOM_REDIRECT_URI'),
      state,
    });
    return { url: `https://zoom.us/oauth/authorize?${params}` };
  }

  async callback(code: string, state: string) {
    let payload: { sub: string; tenantId: string; purpose: string };
    try {
      payload = await this.jwt.verifyAsync(state, { secret: this.config.getOrThrow('JWT_ACCESS_SECRET') });
    } catch {
      throw new BadRequestException(msg('integrations.invalidState'));
    }
    if (payload.purpose !== 'zoom-oauth' || !code) throw new BadRequestException(msg('integrations.invalidState'));

    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.getOrThrow('ZOOM_REDIRECT_URI'),
    });
    if (!tokens) throw new BadRequestException(msg('integrations.zoomLinkFailed'));

    const me = await fetch('https://api.zoom.us/v2/users/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!me.ok) {
      this.logger.error(`Zoom users/me failed: ${me.status} ${await me.text()}`);
      throw new BadRequestException(msg('integrations.zoomLinkFailed'));
    }
    const profile = (await me.json()) as { id: string; email?: string };

    const data = {
      accessToken: this.cipher.seal(tokens.access_token),
      refreshToken: this.cipher.seal(tokens.refresh_token),
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      scope: tokens.scope ?? null,
      externalId: profile.id,
      externalEmail: profile.email ?? null,
    };
    await this.prisma.integration.upsert({
      where: { userId_provider: { userId: payload.sub, provider: 'ZOOM' } },
      update: data,
      create: { tenantId: payload.tenantId, userId: payload.sub, provider: 'ZOOM', ...data },
    });
  }

  /** Revokes the grant at Zoom (best effort) and forgets the tokens. */
  async disconnect(userId: string) {
    const row = await this.prisma.integration.findUnique({
      where: { userId_provider: { userId, provider: 'ZOOM' } },
    });
    if (!row) return;
    if (this.configured && row.refreshToken) {
      const res = await fetch(
        `https://zoom.us/oauth/revoke?${new URLSearchParams({ token: this.cipher.open(row.refreshToken) })}`,
        { method: 'POST', headers: { Authorization: this.basicAuth() } },
      ).catch(() => null);
      if (!res?.ok) this.logger.warn(`Zoom token revoke failed for user ${userId}: ${res?.status ?? 'network'}`);
    }
    await this.prisma.integration.deleteMany({ where: { userId, provider: 'ZOOM' } });
  }

  /** The user removed the app from their Zoom account (`app_deauthorized` webhook). */
  async forgetZoomUser(zoomUserId: string) {
    const { count } = await this.prisma.integration.deleteMany({ where: { provider: 'ZOOM', externalId: zoomUserId } });
    if (count) this.logger.log(`Zoom app deauthorized by Zoom user ${zoomUserId}`);
  }

  /** A valid access token for `userId`, refreshed when it is about to expire. */
  async accessToken(userId: string): Promise<string> {
    const row = await this.prisma.integration.findUnique({
      where: { userId_provider: { userId, provider: 'ZOOM' } },
    });
    if (!row) throw new BadRequestException(msg('meetings.zoomNotLinked'));
    if (row.expiresAt && row.expiresAt.getTime() > Date.now() + 60_000) return this.cipher.open(row.accessToken);
    if (!row.refreshToken) throw new BadRequestException(msg('meetings.zoomReconnect'));

    const pending = this.refreshing.get(userId);
    if (pending) return pending;
    const refresh = this.refresh(row.id, this.cipher.open(row.refreshToken)).finally(() => this.refreshing.delete(userId));
    this.refreshing.set(userId, refresh);
    return refresh;
  }

  /** Drops the stored token after Zoom rejects it, so the next call refreshes. */
  async expireAccessToken(userId: string) {
    await this.prisma.integration.updateMany({
      where: { userId, provider: 'ZOOM' },
      data: { expiresAt: new Date(0) },
    });
  }

  private async refresh(integrationId: string, refreshToken: string) {
    const tokens = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    if (!tokens) throw new BadRequestException(msg('meetings.zoomReconnect'));
    await this.prisma.integration.update({
      where: { id: integrationId },
      data: {
        accessToken: this.cipher.seal(tokens.access_token),
        refreshToken: this.cipher.seal(tokens.refresh_token),
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      },
    });
    return tokens.access_token;
  }

  private async tokenRequest(body: Record<string, string>): Promise<TokenResponse | null> {
    const res = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: { Authorization: this.basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    }).catch((err: unknown) => {
      this.logger.error(`Zoom token request failed: ${String(err)}`);
      throw new ServiceUnavailableException(msg('meetings.zoomUnreachable'));
    });
    if (!res.ok) {
      this.logger.error(`Zoom token ${body.grant_type} failed: ${res.status} ${await res.text()}`);
      return null;
    }
    return (await res.json()) as TokenResponse;
  }

  private basicAuth() {
    const id = this.config.getOrThrow<string>('ZOOM_CLIENT_ID');
    const secret = this.config.getOrThrow<string>('ZOOM_CLIENT_SECRET');
    return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
  }
}
