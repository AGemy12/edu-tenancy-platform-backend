import { Module } from '@nestjs/common';
import { SchedulesController } from './schedules.controller.js';
import { SchedulesService } from './schedules.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';

@Module({
  imports: [SessionsModule],
  controllers: [SchedulesController],
  providers: [SchedulesService],
})
export class SchedulesModule {}
