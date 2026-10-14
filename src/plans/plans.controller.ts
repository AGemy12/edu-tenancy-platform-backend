import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PlansService } from './plans.service.js';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Lang } from '../i18n/lang.decorator.js';
import type { Locale } from '../i18n/locale.js';

@ApiTags('plans')
@ApiBearerAuth()
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  /** Super admin: the whole catalog, hidden and retired packages included, with subscriber counts. */
  @Get('all')
  @Roles('SUPER_ADMIN')
  all() {
    return this.plans.all();
  }

  @Post()
  @Roles('SUPER_ADMIN')
  create(@Body() dto: CreatePlanDto) {
    return this.plans.create(dto);
  }

  @Patch(':id')
  @Roles('SUPER_ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.plans.update(id, dto);
  }

  /** Only a package no center is on; otherwise retire it. */
  @Delete(':id')
  @Roles('SUPER_ADMIN')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.plans.remove(id);
  }

  @Get()
  @Roles('TENANT_ADMIN', 'TEACHER')
  list(@CurrentUser() user: JwtUser, @Lang() locale: Locale) {
    return this.plans.list(user.tenantId!, locale);
  }
}
