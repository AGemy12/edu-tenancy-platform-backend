import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TenantsController } from './tenants.controller.js';
import { TenantsService } from './tenants.service.js';
import { SubscriptionAccess } from './subscription.guard.js';
import { TenantLogoService } from './tenant-logo.service.js';
import { StorageService } from '../library/storage.service.js';

@Module({
  imports: [AuthModule],
  controllers: [TenantsController],
  providers: [TenantsService, SubscriptionAccess, TenantLogoService, StorageService],
  exports: [TenantsService, SubscriptionAccess],
})
export class TenantsModule {}
