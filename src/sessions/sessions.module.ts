import { Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';
import { ZoomWebhookController } from './zoom-webhook.controller.js';
import { ZoomProvider } from './providers/zoom.provider.js';
import { GoogleMeetProvider } from './providers/google-meet.provider.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { CallsController } from './calls.controller.js';
import { CallsService } from './calls.service.js';

@Module({
  imports: [IntegrationsModule],
  controllers: [SessionsController, CallsController, ZoomWebhookController],
  providers: [SessionsService, CallsService, ZoomProvider, GoogleMeetProvider],
  exports: [SessionsService],
})
export class SessionsModule {}
