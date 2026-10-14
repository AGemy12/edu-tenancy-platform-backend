import { Controller, Delete, Get, HttpCode, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IntegrationsService } from './integrations.service.js';
import { ZoomOAuthService } from './zoom-oauth.service.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';

@ApiTags('integrations')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly zoom: ZoomOAuthService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @ApiBearerAuth()
  @Roles('TENANT_ADMIN', 'TEACHER')
  status(@CurrentUser() user: JwtUser) {
    return this.integrations.status(user);
  }

  @Get('google/connect')
  @ApiBearerAuth()
  @Roles('TENANT_ADMIN', 'TEACHER')
  googleConnect(@CurrentUser() user: JwtUser) {
    return this.integrations.googleAuthUrl(user);
  }

  /** Google redirects here; the state JWT identifies the user. */
  @Public()
  @Get('google/callback')
  async googleCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    const front = this.config.get<string>('CORS_ORIGIN') ?? 'http://localhost:3000';
    try {
      await this.integrations.googleCallback(code, state);
      res.redirect(`${front}/dashboard/settings?google=connected`);
    } catch {
      res.redirect(`${front}/dashboard/settings?google=error`);
    }
  }

  @Delete('google')
  @ApiBearerAuth()
  @Roles('TENANT_ADMIN', 'TEACHER')
  @HttpCode(204)
  disconnectGoogle(@CurrentUser() user: JwtUser) {
    return this.integrations.disconnectGoogle(user);
  }

  @Get('zoom/connect')
  @ApiBearerAuth()
  @Roles('TENANT_ADMIN', 'TEACHER')
  zoomConnect(@CurrentUser() user: JwtUser) {
    return this.zoom.authUrl(user);
  }

  /** Zoom redirects here; the state JWT identifies the user. */
  @Public()
  @Get('zoom/callback')
  async zoomCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    const front = this.config.get<string>('CORS_ORIGIN') ?? 'http://localhost:3000';
    try {
      await this.zoom.callback(code, state);
      res.redirect(`${front}/dashboard/settings?zoom=connected`);
    } catch {
      res.redirect(`${front}/dashboard/settings?zoom=error`);
    }
  }

  @Delete('zoom')
  @ApiBearerAuth()
  @Roles('TENANT_ADMIN', 'TEACHER')
  @HttpCode(204)
  disconnectZoom(@CurrentUser() user: JwtUser) {
    return this.zoom.disconnect(user.id);
  }
}
