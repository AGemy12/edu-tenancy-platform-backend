import { Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';
import { ZoomWebhookController } from './zoom-webhook.controller.js';
import { ZoomProvider } from './providers/zoom.provider.js';
import { GoogleMeetProvider } from './providers/google-meet.provider.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';

@Module({
  imports: [IntegrationsModule],
  controllers: [SessionsController, ZoomWebhookController],
  providers: [SessionsService, ZoomProvider, GoogleMeetProvider],
  exports: [SessionsService],
})
export class SessionsModule {}
