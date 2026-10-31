import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { AllowSuspended } from '../auth/account-status.js';
import { AllowExpired } from '../tenants/subscription.guard.js';
import { DenyInSupport } from '../support/support.guard.js';
import { NotificationsService } from './notifications.service.js';
import { AnnouncementsService } from './announcements.service.js';
import { CreateAnnouncementDto, ListNotificationsQueryDto, MarkReadDto, ReadAllDto, SetPreferencesDto } from './dto/notification.dto.js';

/**
 * The signed-in person's notifications in the space they are in (or the platform console).
 * Reading them is open to everyone, suspended or lapsed included. Marking and preferences belong
 * to the person, so support mode can look but not touch.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: JwtUser, @Query() q: ListNotificationsQueryDto) {
    return this.notifications.list(user, q);
  }

  @Get('unread-count')
  async unread(@CurrentUser() user: JwtUser) {
    return { unread: await this.notifications.unread(user) };
  }

  @Post('read')
  @HttpCode(200)
  @AllowSuspended()
  @AllowExpired()
  @DenyInSupport()
  read(@CurrentUser() user: JwtUser, @Body() dto: MarkReadDto) {
    return this.notifications.markRead(user, dto.ids);
  }

  @Post('read-all')
  @HttpCode(200)
  @AllowSuspended()
  @AllowExpired()
  @DenyInSupport()
  readAll(@CurrentUser() user: JwtUser, @Body() dto: ReadAllDto) {
    return this.notifications.markAllRead(user, dto.category);
  }

  @Get('preferences')
  preferences(@CurrentUser() user: JwtUser) {
    return this.notifications.preferences(user);
  }

  @Put('preferences')
  @AllowSuspended()
  @AllowExpired()
  @DenyInSupport()
  setPreferences(@CurrentUser() user: JwtUser, @Body() dto: SetPreferencesDto) {
    return this.notifications.setPreferences(user, dto.items);
  }

  @Delete(':id')
  @AllowSuspended()
  @AllowExpired()
  @DenyInSupport()
  remove(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.remove(user, id);
  }
}

/** A center's admins write to their members; the platform writes to centers. */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('announcements')
@Roles('TENANT_ADMIN', 'SUPER_ADMIN')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  list(@CurrentUser() user: JwtUser) {
    return this.announcements.list(user);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateAnnouncementDto) {
    return this.announcements.create(user, dto);
  }
}
