import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SchedulesService } from './schedules.service.js';
import { CreateScheduleDto, PreviewScheduleDto } from './dto/schedule.dto.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';

/** A student's monthly hours and weekly time slots; saving one creates the month's sessions. */
@ApiTags('schedules')
@ApiBearerAuth()
@Controller('schedules')
@Roles('TENANT_ADMIN', 'TEACHER')
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  list(@CurrentUser() user: JwtUser) {
    return this.schedules.list(user);
  }

  /** The sessions a schedule would create, with clashes flagged. Saves nothing. */
  @Post('preview')
  @HttpCode(200)
  preview(@CurrentUser() user: JwtUser, @Body() dto: PreviewScheduleDto) {
    return this.schedules.preview(user, dto);
  }

  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateScheduleDto) {
    return this.schedules.create(user, dto);
  }

  /** Creates next month's schedule with the same hours and slots. */
  @Post(':id/renew')
  renew(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.schedules.renew(user, id);
  }

  /** Deletes the schedule and its upcoming sessions; sessions already held are kept. */
  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.schedules.remove(user, id);
  }
}
