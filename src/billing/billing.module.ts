import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { PricesService } from './prices.service.js';

@Module({
  controllers: [BillingController],
  providers: [BillingService, PricesService],
  exports: [BillingService, PricesService],
})
export class BillingModule {}
