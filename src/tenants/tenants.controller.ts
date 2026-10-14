import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TenantsService } from './tenants.service.js';
import { SetTenantStatusDto, UpdateSubscriptionDto, UpdateTenantDto } from './dto/tenant.dto.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';

@ApiTags('tenants')
@ApiBearerAuth()
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get('me')
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  me(@CurrentUser('tenantId') tenantId: string) {
    return this.tenants.me(tenantId);
  }

  /** The center's name, timezone and currency. */
  @Patch('me')
  @Roles('TENANT_ADMIN')
  updateMe(@CurrentUser('tenantId') tenantId: string, @Body() dto: UpdateTenantDto) {
    return this.tenants.updateMe(tenantId, dto);
  }

  @Get('me/stats')
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  stats(@CurrentUser() user: JwtUser) {
    return this.tenants.stats(user);
  }

  /** Super admin: the platform at a glance. */
  @Get('overview')
  @Roles('SUPER_ADMIN')
  overview() {
    return this.tenants.overview();
  }

  @Get()
  @Roles('SUPER_ADMIN')
  listAll() {
    return this.tenants.listAll();
  }

  /** Super admin: one center in depth. */
  @Get(':id')
  @Roles('SUPER_ADMIN')
  detail(@Param('id') id: string) {
    return this.tenants.detail(id);
  }

  @Patch(':id/status')
  @Roles('SUPER_ADMIN')
  setStatus(@Param('id') id: string, @Body() dto: SetTenantStatusDto) {
    return this.tenants.setStatus(id, dto.status);
  }

  /** Manual renewals and package changes, until online payments exist. */
  @Patch(':id/subscription')
  @Roles('SUPER_ADMIN')
  updateSubscription(@Param('id') id: string, @Body() dto: UpdateSubscriptionDto) {
    return this.tenants.updateSubscription(id, dto);
  }
}
