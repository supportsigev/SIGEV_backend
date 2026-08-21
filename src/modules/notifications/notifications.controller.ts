import {
  Controller, Get, Patch, Post, Param, Delete, Body, UseGuards, Sse, MessageEvent,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { NotificationsService } from './notifications.service';
import { NotificationsStreamService } from './notifications-stream.service';
import { CurrentUser } from '../../common/decorators';
import { RolesGuard } from '../../common/guards';
import { UserWithRoles } from '../../database/types';

export class CreateNotificationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  type: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  message: string;

  @IsString()
  @IsNotEmpty()
  eventId: string;
}

@ApiTags('Notificaciones')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly notificationsStreamService: NotificationsStreamService,
  ) {}

  @Sse('stream')
  @ApiOperation({
    summary: 'Stream de notificaciones en tiempo real (Server-Sent Events)',
  })
  stream(@CurrentUser() user: UserWithRoles): Observable<MessageEvent> {
    return this.notificationsStreamService.subscribe(user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Crear notificación para los operadores de la orden' })
  async create(@Body() dto: CreateNotificationDto) {
    await this.notificationsService.notifyOperatorsForEvent(
      dto.eventId,
      dto.type,
      dto.message,
    );
    return { ok: true };
  }

  @Get()
  @ApiOperation({ summary: 'Listar notificaciones del usuario autenticado' })
  findAll(@CurrentUser() user: UserWithRoles) {
    return this.notificationsService.findAllForUser(user.id);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Cantidad de notificaciones no leídas' })
  unreadCount(@CurrentUser() user: UserWithRoles) {
    return this.notificationsService.unreadCount(user.id);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Marcar todas las notificaciones como leídas' })
  markAllRead(@CurrentUser() user: UserWithRoles) {
    return this.notificationsService.markAllRead(user.id);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Marcar una notificación como leída' })
  markRead(@Param('id') id: string, @CurrentUser() user: UserWithRoles) {
    return this.notificationsService.markRead(id, user.id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar una notificación' })
  remove(@Param('id') id: string, @CurrentUser() user: UserWithRoles) {
    return this.notificationsService.remove(id, user.id);
  }
}
