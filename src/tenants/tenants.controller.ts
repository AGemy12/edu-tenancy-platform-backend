import { Body, Controller, Delete, Get, Param, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { TenantsService } from './tenants.service.js';
import { LOGO_MAX_MB, TenantLogoService, type UploadedLogo } from './tenant-logo.service.js';
import { BulkPlatformFeeDto, CreateTenantByAdminDto, SetPlatformFeeDto, SetTenantStatusDto, UpdateSubscriptionDto, UpdateTenantDto } from './dto/tenant.dto.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Lang } from '../i18n/lang.decorator.js';
import type { Locale } from '../i18n/locale.js';

@ApiTags('tenants')
@ApiBearerAuth()
@Controller('tenants')
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly logo: TenantLogoService,
  ) {}

  @Get('me')
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  me(@CurrentUser('tenantId') tenantId: string) {
    return this.withLogo(this.tenants.me(tenantId));
  }

  /** The center's name, timezone and currency. */
  @Patch('me')
  @Roles('TENANT_ADMIN')
  updateMe(@CurrentUser('tenantId') tenantId: string, @Body() dto: UpdateTenantDto) {
    return this.withLogo(this.tenants.updateMe(tenantId, dto));
  }

  /** The center's logo for its reports: PNG, JPG or WebP, re-encoded to a small PNG. */
  @Post('me/logo')
  @Roles('TENANT_ADMIN')
  @ApiConsumes('multipart/form-data')
  // Kept in memory: the service refuses anything over LOGO_MAX_MB, so this is only a hard stop.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LOGO_MAX_MB * 4 * 1024 * 1024, files: 1 } }))
  async uploadLogo(@CurrentUser('tenantId') tenantId: string, @UploadedFile() file: UploadedLogo | undefined) {
    await this.logo.set(tenantId, file);
    return this.withLogo(this.tenants.me(tenantId));
  }

  @Delete('me/logo')
  @Roles('TENANT_ADMIN')
  async removeLogo(@CurrentUser('tenantId') tenantId: string) {
    await this.logo.remove(tenantId);
    return this.withLogo(this.tenants.me(tenantId));
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

  /** Super admin: set up a center with its owner and package. */
  @Post()
  @Roles('SUPER_ADMIN')
  create(@CurrentUser('id') actorId: string, @Body() dto: CreateTenantByAdminDto, @Lang() locale: Locale) {
    return this.tenants.create(dto, actorId, locale);
  }

  /** Super admin: one commission for many centers (chosen ones, or all except some). Declared before `:id` routes. */
  @Patch('platform-fee')
  @Roles('SUPER_ADMIN')
  bulkPlatformFee(@Body() dto: BulkPlatformFeeDto) {
    return this.tenants.bulkPlatformFee(dto);
  }

  /** Super admin: set or remove the platform's commission on one center. */
  @Patch(':id/platform-fee')
  @Roles('SUPER_ADMIN')
  setPlatformFee(@Param('id') id: string, @Body() dto: SetPlatformFeeDto) {
    return this.tenants.setPlatformFee(id, dto.percent);
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
  updateSubscription(@CurrentUser('id') actorId: string, @Param('id') id: string, @Body() dto: UpdateSubscriptionDto) {
    return this.tenants.updateSubscription(id, dto, actorId);
  }

  /** The center as the app sees it: a signed link to its logo instead of the storage key. */
  private async withLogo<T extends { logoKey: string | null }>(pending: Promise<T>) {
    const { logoKey, ...tenant } = await pending;
    return { ...tenant, logoUrl: this.logo.url(logoKey) };
  }
}
