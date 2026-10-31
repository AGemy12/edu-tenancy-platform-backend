import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { DenyInSupport } from '../support/support.guard.js';
import { CallsService } from './calls.service.js';

/**
 * Calls between a teacher and their student from their direct chat, during one of their sessions.
 * Like the chat they ride on, calls are the member's own: never in support mode.
 */
@ApiTags('calls')
@ApiBearerAuth()
@Controller()
@Roles('TEACHER', 'STUDENT')
@DenyInSupport()
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  /** { session, call }: the session a call would join now (null: calling is closed), and the call to rejoin. */
  @Get('conversations/:id/call')
  state(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.calls.state(user, id);
  }

  /** Rings the other side; returns { url, call } for the caller (or joins the call already on). */
  @Post('conversations/:id/call')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  place(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.calls.place(user, id);
  }

  /** Answers a ringing call or goes back into one; returns { url, call }. */
  @Post('calls/:id/join')
  @HttpCode(200)
  join(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.calls.join(user, id);
  }

  /** Declines, calls off or hangs up. */
  @Post('calls/:id/end')
  @HttpCode(200)
  end(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.calls.end(user, id);
  }
}
