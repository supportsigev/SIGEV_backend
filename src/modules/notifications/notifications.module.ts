import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsStreamService } from './notifications-stream.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsStreamService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
