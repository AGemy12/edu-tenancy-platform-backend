import { Controller, Headers, HttpCode, Logger, Post, Req, UnauthorizedException, type RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator.js';
import { ZoomOAuthService } from '../integrations/zoom-oauth.service.js';
import { urlValidationResponse, verifyZoomSignature } from '../integrations/zoom-signature.js';
import { SessionsService } from './sessions.service.js';

type ZoomEvent = {
  event: string;
  event_ts?: number;
  payload: {
    plainToken?: string;
    user_id?: string;
    object?: {
      id?: number | string;
      start_time?: string;
      end_time?: string;
      participant?: { email?: string; join_time?: string };
    };
  };
};

/**
 * Zoom event subscription for the platform's Zoom app. Configure it in the app's
 * "Event Subscriptions" with this URL and the events below; the secret token goes in
 * ZOOM_WEBHOOK_SECRET_TOKEN. Docs: https://developers.zoom.us/docs/api/webhooks/
 */
@ApiExcludeController()
@Controller('zoom')
export class ZoomWebhookController {
  private readonly logger = new Logger(ZoomWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sessions: SessionsService,
    private readonly oauth: ZoomOAuthService,
  ) {}

  @Public()
  @SkipThrottle()
  @Post('webhook')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-zm-request-timestamp') timestamp?: string,
    @Headers('x-zm-signature') signature?: string,
  ) {
    const secret = this.config.get<string>('ZOOM_WEBHOOK_SECRET_TOKEN');
    if (!secret || !req.rawBody) throw new UnauthorizedException();
    if (!verifyZoomSignature(secret, { timestamp, signature }, req.rawBody)) throw new UnauthorizedException();

    const body = JSON.parse(req.rawBody.toString('utf8')) as ZoomEvent;
    const meetingId = body.payload.object?.id != null ? String(body.payload.object.id) : null;
    const eventTime = body.event_ts ? new Date(body.event_ts) : new Date();

    switch (body.event) {
      case 'endpoint.url_validation':
        return urlValidationResponse(secret, body.payload.plainToken ?? '');
      case 'meeting.started':
        if (meetingId) await this.sessions.providerStarted('ZOOM', meetingId, dateOr(body.payload.object?.start_time, eventTime));
        break;
      case 'meeting.ended':
        if (meetingId) {
          const startedAt = body.payload.object?.start_time ? new Date(body.payload.object.start_time) : null;
          await this.sessions.providerEnded('ZOOM', meetingId, startedAt, dateOr(body.payload.object?.end_time, eventTime));
        }
        break;
      case 'meeting.participant_joined': {
        const p = body.payload.object?.participant;
        // Zoom only sends the email of participants signed in to Zoom.
        if (meetingId && p?.email) {
          await this.sessions.providerParticipantJoined('ZOOM', meetingId, p.email, dateOr(p.join_time, eventTime));
        }
        break;
      }
      case 'app_deauthorized':
        if (body.payload.user_id) await this.oauth.forgetZoomUser(body.payload.user_id);
        break;
      default:
        this.logger.debug(`Ignoring Zoom event ${body.event}`);
    }
    return { ok: true };
  }
}

function dateOr(value: string | undefined, fallback: Date) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d : fallback;
}
