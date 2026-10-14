import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BillingService } from './billing.service.js';
import {
  BillingSessionsQueryDto,
  BillingSummaryQueryDto,
  CreateRateDto,
  RatesQueryDto,
  UpdateRateDto,
} from './dto/billing.dto.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';

/**
 * Session billing: time and money per session, computed from the rate card. Admins see the
 * whole center, teachers their own sessions and pay, students only their own charges.
 */
@ApiTags('billing')
@ApiBearerAuth()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('sessions')
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  sessions(@CurrentUser() user: JwtUser, @Query() q: BillingSessionsQueryDto) {
    return this.billing.sessions(user, q);
  }

  @Get('summary')
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  summary(@CurrentUser() user: JwtUser, @Query() q: BillingSummaryQueryDto) {
    return this.billing.summary(user, q);
  }

  /** Filter choices scoped to the viewer, plus the center's currency. */
  @Get('options')
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  options(@CurrentUser() user: JwtUser) {
    return this.billing.options(user);
  }

  @Get('rates')
  @Roles('TENANT_ADMIN', 'TEACHER')
  rates(@CurrentUser() user: JwtUser, @Query() q: RatesQueryDto) {
    return this.billing.listRates(user, q);
  }

  @Post('rates')
  @Roles('TENANT_ADMIN')
  createRate(@CurrentUser() user: JwtUser, @Body() dto: CreateRateDto) {
    return this.billing.createRate(user, dto);
  }

  @Patch('rates/:id')
  @Roles('TENANT_ADMIN')
  updateRate(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: UpdateRateDto) {
    return this.billing.updateRate(user, id, dto);
  }

  @Delete('rates/:id')
  @Roles('TENANT_ADMIN')
  @HttpCode(204)
  removeRate(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.billing.removeRate(user, id);
  }
}
