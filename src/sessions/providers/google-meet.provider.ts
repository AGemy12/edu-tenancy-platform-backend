import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TokenCipher } from '../../integrations/token-cipher.js';
import type { CreateMeetingInput, MeetingDetails, MeetingProvider, MeetingResult } from './meeting-provider.interface.js';
import { msg } from '../../i18n/i18n.js';

const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/**
 * Google Meet via the Calendar API: creating a calendar event with
 * `conferenceData` produces a Meet link. Requires the teacher to connect
 * their Google account (OAuth) — tokens live in the `Integration` table.
 * Docs: https://developers.google.com/calendar/api/v3/reference/events/insert
 */
@Injectable()
export class GoogleMeetProvider implements MeetingProvider {
  private readonly logger = new Logger(GoogleMeetProvider.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipher,
  ) {}

  async createMeeting(input: CreateMeetingInput): Promise<MeetingResult> {
    const token = await this.accessToken(input.hostUserId);
    const res = await fetch(`${EVENTS}?conferenceDataVersion=1&sendUpdates=all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...eventBody(input),
        attendees: input.attendeeEmails.map((email) => ({ email })),
        conferenceData: {
          createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
        },
      }),
    });
    if (!res.ok) {
      this.logger.error(`Google event create failed: ${res.status} ${await res.text()}`);
      throw new ServiceUnavailableException(msg('meetings.googleCreateFailed'));
    }
    const data = (await res.json()) as { id: string; hangoutLink?: string };
    if (!data.hangoutLink) throw new ServiceUnavailableException(msg('meetings.googleNoLink'));
    return { externalMeetingId: data.id, joinUrl: data.hangoutLink };
  }

  async updateMeeting(hostUserId: string, externalMeetingId: string, details: MeetingDetails) {
    const token = await this.accessToken(hostUserId);
    const res = await fetch(`${EVENTS}/${encodeURIComponent(externalMeetingId)}?sendUpdates=all`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody(details)),
    });
    if (!res.ok) {
      this.logger.error(`Google event update failed: ${res.status} ${await res.text()}`);
      throw new ServiceUnavailableException(msg('meetings.googleUpdateFailed'));
    }
  }

  async deleteMeeting(hostUserId: string, externalMeetingId: string) {
    const token = await this.accessToken(hostUserId);
    const res = await fetch(`${EVENTS}/${encodeURIComponent(externalMeetingId)}?sendUpdates=all`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      this.logger.warn(`Google delete event ${externalMeetingId} failed: ${res.status}`);
    }
  }

  /** Meet has no separate host link: the organiser joins with the normal link. */
  hostUrl() {
    return Promise.resolve(null);
  }

  /** Returns a valid access token for the host, refreshing it when expired. */
  private async accessToken(hostUserId: string): Promise<string> {
    const integration = await this.prisma.integration.findUnique({
      where: { userId_provider: { userId: hostUserId, provider: 'GOOGLE' } },
    });
    if (!integration) {
      throw new ServiceUnavailableException(msg('meetings.googleNotLinked'));
    }
    const stillValid = integration.expiresAt && integration.expiresAt.getTime() > Date.now() + 60_000;
    if (stillValid) return this.cipher.open(integration.accessToken);
    if (!integration.refreshToken) throw new ServiceUnavailableException(msg('meetings.googleReconnect'));

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.getOrThrow('GOOGLE_CLIENT_ID'),
        client_secret: this.config.getOrThrow('GOOGLE_CLIENT_SECRET'),
        refresh_token: this.cipher.open(integration.refreshToken),
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) {
      this.logger.error(`Google token refresh failed: ${res.status} ${await res.text()}`);
      throw new ServiceUnavailableException(msg('meetings.googleReconnect'));
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    await this.prisma.integration.update({
      where: { id: integration.id },
      data: {
        accessToken: this.cipher.seal(data.access_token),
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
      },
    });
    return data.access_token;
  }
}

function eventBody(d: MeetingDetails) {
  return {
    summary: d.title,
    description: d.description ?? '',
    start: { dateTime: d.startAt.toISOString(), timeZone: d.timezone },
    end: { dateTime: d.endAt.toISOString(), timeZone: d.timezone },
  };
}
