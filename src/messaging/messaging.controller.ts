import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { AllowSuspended } from '../auth/account-status.js';
import { AllowExpired } from '../tenants/subscription.guard.js';
import { DenyInSupport } from '../support/support.guard.js';
import { MessagingService } from './messaging.service.js';
import {
  AddMembersDto,
  ContactsQueryDto,
  ConversationSettingsDto,
  CreateGroupDto,
  EditMessageDto,
  InboxQueryDto,
  MessagesQueryDto,
  SendMessageDto,
  SetMemberRoleDto,
  StartDirectDto,
  UpdateGroupDto,
} from './dto/messaging.dto.js';

/**
 * Messages between a center's members. A member's conversations are theirs: support mode never
 * reads or writes them (`@DenyInSupport`). Suspended members and lapsed centers keep reading
 * (and may mark read, mute, archive) but can't send.
 */
@ApiTags('messages')
@ApiBearerAuth()
@Controller('conversations')
@Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
@DenyInSupport()
export class ConversationsController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  inbox(@CurrentUser() user: JwtUser, @Query() q: InboxQueryDto) {
    return this.messaging.inbox(user, q.archived);
  }

  @Get('unread')
  unread(@CurrentUser() user: JwtUser) {
    return this.messaging.unread(user);
  }

  @Get('contacts')
  contacts(@CurrentUser() user: JwtUser, @Query() q: ContactsQueryDto) {
    return this.messaging.contacts(user, q);
  }

  @Post('direct')
  @HttpCode(200)
  direct(@CurrentUser() user: JwtUser, @Body() dto: StartDirectDto) {
    return this.messaging.startDirect(user, dto.membershipId);
  }

  @Post('groups')
  @Roles('TENANT_ADMIN', 'TEACHER')
  createGroup(@CurrentUser() user: JwtUser, @Body() dto: CreateGroupDto) {
    return this.messaging.createGroup(user, dto);
  }

  @Get(':id')
  detail(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.messaging.detail(user, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGroupDto) {
    return this.messaging.updateGroup(user, id, dto);
  }

  @Post(':id/members')
  addMembers(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddMembersDto) {
    return this.messaging.addMembers(user, id, dto.membershipIds);
  }

  @Patch(':id/members/:membershipId')
  setMemberRole(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: SetMemberRoleDto,
  ) {
    return this.messaging.setMemberRole(user, id, membershipId, dto.isAdmin);
  }

  /** Removes a member (group admins), or leaves when it is the caller's own id. */
  @Delete(':id/members/:membershipId')
  @AllowSuspended()
  @AllowExpired()
  removeMember(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string, @Param('membershipId', ParseUUIDPipe) membershipId: string) {
    return this.messaging.removeMember(user, id, membershipId);
  }

  @Patch(':id/settings')
  @AllowSuspended()
  @AllowExpired()
  settings(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConversationSettingsDto) {
    return this.messaging.settings(user, id, dto);
  }

  @Post(':id/read')
  @HttpCode(200)
  @AllowSuspended()
  @AllowExpired()
  read(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.messaging.markRead(user, id);
  }

  @Get(':id/messages')
  messages(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: MessagesQueryDto) {
    return this.messaging.messages(user, id, q);
  }

  @Post(':id/messages')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  send(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendMessageDto) {
    return this.messaging.send(user, id, dto);
  }
}

@ApiTags('messages')
@ApiBearerAuth()
@Controller('messages')
@Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
@DenyInSupport()
export class MessagesController {
  constructor(private readonly messaging: MessagingService) {}

  @Patch(':id')
  edit(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EditMessageDto) {
    return this.messaging.edit(user, id, dto.body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.messaging.remove(user, id);
  }
}
