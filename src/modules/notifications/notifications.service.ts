import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { ROLES } from '../../config/constants';
import { NotificationsStreamService } from './notifications-stream.service';

const notificationInclude = {
  event: { select: { id: true, code: true, suffix: true } },
} as const;

type NotificationWithEvent = Prisma.NotificationGetPayload<{
  include: typeof notificationInclude;
}>;

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: NotificationsStreamService,
  ) {}

  async createMany(
    userIds: string[],
    data: { eventId: string; type: string; message: string },
  ): Promise<void> {
    const unique = Array.from(new Set(userIds.filter((id) => !!id)));
    if (!unique.length) return;
    await this.prisma.notification.createMany({
      data: unique.map((userId) => ({ userId, ...data })),
    });
    this.stream.emitToUsers(unique, {
      type: data.type,
      message: data.message,
      eventId: data.eventId,
    });
  }

  async findUserIdsByRoles(roleNames: string[]): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: { isActive: true, roles: { some: { name: { in: roleNames } } } },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  async findOperatorUserIdsForAlly(
    allyId: string | null | undefined,
  ): Promise<string[]> {
    if (!allyId) return [];
    const users = await this.prisma.user.findMany({
      where: { isActive: true, allyId, roles: { some: { name: ROLES.OPERATOR } } },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  async findAllForUser(userId: string): Promise<NotificationWithEvent[]> {
    return this.prisma.notification.findMany({
      where: { userId },
      include: notificationInclude,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, read: false },
    });
  }

  async markRead(id: string, userId: string): Promise<NotificationWithEvent> {
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId },
    });
    if (!notification) throw new NotFoundException('Notificación no encontrada');
    return this.prisma.notification.update({
      where: { id },
      data: { read: true, readAt: new Date() },
      include: notificationInclude,
    });
  }

  async markAllRead(userId: string): Promise<{ count: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true, readAt: new Date() },
    });
    return { count: result.count };
  }

  async remove(id: string, userId: string): Promise<void> {
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId },
    });
    if (!notification) throw new NotFoundException('Notificación no encontrada');
    await this.prisma.notification.delete({ where: { id } });
  }

  async notifyOperatorsForEvent(
    eventId: string,
    type: string,
    message: string,
  ): Promise<void> {
    const operatorIds = await this.findUserIdsByRoles([ROLES.OPERATOR]);
    if (!operatorIds.length) return;
    await this.createMany(operatorIds, { eventId, type, message });
  }
}
