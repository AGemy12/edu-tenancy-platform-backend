import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SupportAccessController, SupportController } from './support.controller.js';
import { SupportService } from './support.service.js';

@Module({
  imports: [AuthModule],
  controllers: [SupportController, SupportAccessController],
  providers: [SupportService],
})
export class SupportModule {}
