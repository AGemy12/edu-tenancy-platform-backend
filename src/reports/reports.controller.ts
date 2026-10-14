import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ReportsService } from './reports.service.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { msg } from '../i18n/i18n.js';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('monthly')
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  monthly(@CurrentUser() user: JwtUser, @Query('month') month?: string) {
    const now = new Date();
    const value = month ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new BadRequestException(msg('reports.invalidMonth'));
    return this.reports.monthly(user, value);
  }
}
