import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ZoomOAuthService } from '../../integrations/zoom-oauth.service.js';
import type { CreateMeetingInput, MeetingDetails, MeetingProvider, MeetingResult } from './meeting-provider.interface.js';
import { msg, type MessageKey } from '../../i18n/i18n.js';

const API = 'https://api.zoom.us/v2';

/**
 * Zoom meetings on the host teacher's own Zoom account (see ZoomOAuthService).
 * Docs: https://developers.zoom.us/docs/api/meetings/
 */
@Injectable()
export class ZoomProvider implements MeetingProvider {
  private readonly logger = new Logger(ZoomProvider.name);

  constructor(private readonly oauth: ZoomOAuthService) {}

  async createMeeting(input: CreateMeetingInput): Promise<MeetingResult> {
    const res = await this.call(input.hostUserId, 'POST', '/users/me/meetings', 'meetings.zoomCreateFailed', {
      ...meetingBody(input),
      type: 2, // scheduled
      settings: {
        join_before_host: false, // students wait until the teacher starts the class
        mute_upon_entry: true,
        approval_type: 2, // no registration
        auto_recording: 'none',
      },
    });
    const data = (await res.json()) as { id: number; join_url: string };
    return { externalMeetingId: String(data.id), joinUrl: data.join_url };
  }

  async updateMeeting(hostUserId: string, externalMeetingId: string, details: MeetingDetails) {
    await this.call(hostUserId, 'PATCH', `/meetings/${externalMeetingId}`, 'meetings.zoomUpdateFailed', meetingBody(details));
  }

  async deleteMeeting(hostUserId: string, externalMeetingId: string) {
    await this.call(hostUserId, 'DELETE', `/meetings/${externalMeetingId}`, 'meetings.zoomUnreachable', undefined, [404]);
  }

  /** Zoom start links carry a host token that expires within hours, so they are never stored. */
  async hostUrl(hostUserId: string, externalMeetingId: string) {
    const res = await this.call(hostUserId, 'GET', `/meetings/${externalMeetingId}`, 'meetings.zoomUnreachable');
    return ((await res.json()) as { start_url: string }).start_url;
  }

  /** Calls the Zoom API as the host, retrying once with a fresh token if Zoom rejects it. */
  private async call(
    hostUserId: string,
    method: string,
    path: string,
    failure: MessageKey,
    body?: unknown,
    okStatuses: number[] = [],
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.oauth.accessToken(hostUserId);
      const res = await fetch(API + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }).catch((err: unknown) => {
        this.logger.error(`Zoom ${method} ${path} failed: ${String(err)}`);
        throw new ServiceUnavailableException(msg('meetings.zoomUnreachable'));
      });
      if (res.ok || okStatuses.includes(res.status)) return res;
      if (res.status === 401 && attempt === 0) {
        await this.oauth.expireAccessToken(hostUserId);
        continue;
      }
      this.logger.error(`Zoom ${method} ${path} failed: ${res.status} ${await res.text()}`);
      if (res.status === 401) throw new BadRequestException(msg('meetings.zoomReconnect'));
      if (res.status === 404) throw new BadRequestException(msg('meetings.zoomMeetingGone'));
      throw new ServiceUnavailableException(msg(failure));
    }
  }
}

/** Zoom wants `yyyy-MM-ddTHH:mm:ssZ` (no milliseconds) and a whole-minute duration. */
export function meetingBody(d: MeetingDetails) {
  return {
    topic: d.title.slice(0, 200),
    agenda: (d.description ?? '').slice(0, 2000),
    start_time: d.startAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    duration: Math.max(1, Math.round((d.endAt.getTime() - d.startAt.getTime()) / 60_000)),
    timezone: d.timezone,
  };
}
