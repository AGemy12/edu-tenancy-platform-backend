import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SessionsService } from './sessions.service.js';
import { AttendanceDto, CreateSessionDto, EvaluateSessionDto, UpdateSessionDto } from './dto/session.dto.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';

@ApiTags('sessions')
@ApiBearerAuth()
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  list(@CurrentUser() user: JwtUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.sessions.list(user, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @Get(':id')
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  get(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.sessions.get(user, id);
  }

  @Post()
  @Roles('TENANT_ADMIN', 'TEACHER')
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateSessionDto) {
    return this.sessions.create(user, dto);
  }

  @Patch(':id')
  @Roles('TENANT_ADMIN', 'TEACHER')
  update(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: UpdateSessionDto) {
    return this.sessions.update(user, id, dto);
  }

  /** The host opens the meeting: returns { url } and marks the session live. */
  @Post(':id/start')
  @Roles('TENANT_ADMIN', 'TEACHER')
  @HttpCode(200)
  start(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.sessions.start(user, id);
  }

  @Post(':id/complete')
  @Roles('TENANT_ADMIN', 'TEACHER')
  @HttpCode(200)
  complete(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.sessions.complete(user, id);
  }

  /** Returns { url } to join; for a student this also records attendance. */
  @Post(':id/join')
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  @HttpCode(200)
  join(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.sessions.join(user, id);
  }

  @Post(':id/cancel')
  @Roles('TENANT_ADMIN', 'TEACHER')
  @HttpCode(200)
  cancel(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.sessions.cancel(user, id);
  }

  @Post(':id/attendance')
  @Roles('TENANT_ADMIN', 'TEACHER')
  attendance(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: AttendanceDto) {
    return this.sessions.markAttendance(user, id, dto.studentId, dto.attended);
  }

  /** The teacher's evaluation after the session: status, rating, homework, progress and a note per student. */
  @Post(':id/evaluations')
  @Roles('TENANT_ADMIN', 'TEACHER')
  @HttpCode(200)
  evaluate(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: EvaluateSessionDto) {
    return this.sessions.evaluate(user, id, dto);
  }

  @Delete(':id')
  @Roles('TENANT_ADMIN', 'TEACHER')
  @HttpCode(204)
  remove(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.sessions.remove(user, id);
  }
}
