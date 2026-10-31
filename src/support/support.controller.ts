import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SupportService } from './support.service.js';
import { ApproveSupportDto, ListSupportQueryDto, RequestSupportDto, StartSupportDto } from './dto/support.dto.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Lang } from '../i18n/lang.decorator.js';
import type { Locale } from '../i18n/locale.js';
import { AllowExpired } from '../tenants/subscription.guard.js';
import { AllowSuspended } from '../auth/account-status.js';
import { SkipSupportAudit } from './support-audit.interceptor.js';
import { DenyInSupport } from './support.guard.js';

/** Platform side: ask a center for access, then enter under an approved request. */
@ApiTags('support')
@ApiBearerAuth()
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  /** Super admin: ask a center's admins to let support in. */
  @Post('requests')
  @Roles('SUPER_ADMIN')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  request(@CurrentUser() user: JwtUser, @Body() dto: RequestSupportDto, @Lang() locale: Locale) {
    return this.support.request(user, dto, locale);
  }

  @Get('requests')
  @Roles('SUPER_ADMIN')
  requests(@Query() q: ListSupportQueryDto) {
    return this.support.listRequests(q);
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  @Roles('SUPER_ADMIN')
  cancel(@Param('id') id: string) {
    return this.support.cancel(id);
  }

  /** Super admin: enter a center under an approved request. Returns the new token pair. */
  @Post('sessions')
  @Roles('SUPER_ADMIN')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  start(@CurrentUser() user: JwtUser, @Body() dto: StartSupportDto) {
    return this.support.start(user, dto.requestId);
  }

  /** Leave support mode: closes the session this request is made from. Declared before `:id`. */
  @Post('sessions/current/end')
  @HttpCode(200)
  @SkipSupportAudit()
  @AllowExpired()
  @AllowSuspended()
  endCurrent(@CurrentUser() user: JwtUser) {
    return this.support.endCurrent(user);
  }

  @Get('sessions')
  @Roles('SUPER_ADMIN')
  sessions(@Query() q: ListSupportQueryDto) {
    return this.support.list(q);
  }

  @Get('sessions/:id/actions')
  @Roles('SUPER_ADMIN')
  actions(@Param('id') id: string) {
    return this.support.actions(id);
  }

  /** Super admin: close any open session from the console. */
  @Post('sessions/:id/end')
  @HttpCode(200)
  @Roles('SUPER_ADMIN')
  end(@Param('id') id: string) {
    return this.support.end(id);
  }
}

/**
 * Center side: its admins decide who from support may come in, for how long, and see what was
 * done. Never reachable from support mode itself, so support can't approve its own request.
 */
@ApiTags('support')
@ApiBearerAuth()
@Controller('support/access')
@Roles('TENANT_ADMIN')
@DenyInSupport()
@AllowExpired()
export class SupportAccessController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@CurrentUser() user: JwtUser) {
    return this.support.forCenter(user);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: ApproveSupportDto) {
    return this.support.approve(user, id, dto.hours);
  }

  @Post(':id/deny')
  @HttpCode(200)
  deny(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.support.deny(user, id);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.support.revoke(user, id);
  }

  @Get('sessions/:id/actions')
  actions(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.support.actions(id, user.tenantId!);
  }
}
