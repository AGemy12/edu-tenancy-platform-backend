import { Module } from '@nestjs/common';
import { TenantsController } from './tenants.controller.js';
import { TenantsService } from './tenants.service.js';
import { SubscriptionAccess } from './subscription.guard.js';

@Module({
  controllers: [TenantsController],
  providers: [TenantsService, SubscriptionAccess],
  exports: [TenantsService, SubscriptionAccess],
})
export class TenantsModule {}
