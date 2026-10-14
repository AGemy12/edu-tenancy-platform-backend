import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { TokenCipher } from './token-cipher.js';
import { ZoomOAuthService } from './zoom-oauth.service.js';

@Module({
  imports: [JwtModule.register({})],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, TokenCipher, ZoomOAuthService],
  exports: [TokenCipher, ZoomOAuthService],
})
export class IntegrationsModule {}
