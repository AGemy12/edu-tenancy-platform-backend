import { Global, Module } from '@nestjs/common';
import { ConversationsController, MessagesController } from './messaging.controller.js';
import { MessagingService } from './messaging.service.js';

/** Global: course groups follow enrollments, so CoursesService reaches in. */
@Global()
@Module({
  controllers: [ConversationsController, MessagesController],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
