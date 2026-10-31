import { Global, Module } from '@nestjs/common';
import { AnnouncementsController, NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { NotificationEvents } from './notification-events.js';
import { NotificationJobs } from './notification-jobs.js';
import { AnnouncementsService } from './announcements.service.js';

/** Global: any service can raise an event through `NotificationEvents`. */
@Global()
@Module({
  controllers: [NotificationsController, AnnouncementsController],
  providers: [NotificationsService, NotificationEvents, NotificationJobs, AnnouncementsService],
  exports: [NotificationsService, NotificationEvents],
})
export class NotificationsModule {}
