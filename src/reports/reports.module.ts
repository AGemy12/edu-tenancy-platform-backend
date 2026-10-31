import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { StorageService } from '../library/storage.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { PdfRenderer } from './pdf/pdf-renderer.service.js';
import { ReportPdfService } from './pdf/report-pdf.service.js';

@Module({
  imports: [BillingModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportPdfService, PdfRenderer, StorageService],
})
export class ReportsModule {}
