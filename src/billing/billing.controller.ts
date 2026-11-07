import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BillingService } from './billing.service.js';
import { PricesService } from './prices.service.js';
import {
  BillingSessionsQueryDto,
  BillingSummaryQueryDto,
  PlatformBillingQueryDto,
  SetPriceDto,
  SetSpecialPriceDto,
  SetTeacherPayDto,
} from './dto/billing.dto.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';

/**
 * Session billing: money per session, computed from the center's prices. Admins see the whole
 * center, teachers their own sessions and pay, students only their own charges.
 */
@ApiTags('billing')
@ApiBearerAuth()
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly prices: PricesService,
  ) {}

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

  /** Super admin: subscription prices and session fees per center over a period. */
  @Get('platform')
  @Roles('SUPER_ADMIN')
  platform(@Query() q: PlatformBillingQueryDto) {
    return this.billing.platform(q);
  }

  /** The center's prices: default, per course, special, and teachers' pay (a teacher sees theirs). */
  @Get('prices')
  @Roles('TENANT_ADMIN', 'TEACHER')
  listPrices(@CurrentUser() user: JwtUser) {
    return this.prices.list(user);
  }

  @Put('prices/default')
  @Roles('TENANT_ADMIN')
  async setDefaultPrice(@CurrentUser() user: JwtUser, @Body() dto: SetPriceDto) {
    await this.prices.setDefaultPrice(user.tenantId!, dto.amount);
    return this.prices.list(user);
  }

  @Put('prices/courses/:courseId')
  @Roles('TENANT_ADMIN')
  async setCoursePrice(@CurrentUser() user: JwtUser, @Param('courseId', ParseUUIDPipe) courseId: string, @Body() dto: SetPriceDto) {
    await this.prices.setCoursePrice(user.tenantId!, courseId, dto.amount);
    return this.prices.list(user);
  }

  @Put('prices/special')
  @Roles('TENANT_ADMIN')
  async setSpecialPrice(@CurrentUser() user: JwtUser, @Body() dto: SetSpecialPriceDto) {
    await this.prices.setSpecialPrice(user.tenantId!, dto.courseId, dto.studentId, dto.amount);
    return this.prices.list(user);
  }

  @Put('pay/:teacherId')
  @Roles('TENANT_ADMIN')
  async setTeacherPay(@CurrentUser() user: JwtUser, @Param('teacherId', ParseUUIDPipe) teacherId: string, @Body() dto: SetTeacherPayDto) {
    await this.prices.setTeacherPay(user.tenantId!, teacherId, dto.amount === null ? null : { basis: dto.basis ?? 'PER_SESSION', amount: dto.amount });
    return this.prices.list(user);
  }
}
