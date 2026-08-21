import { Injectable, Logger } from '@nestjs/common';
import { MessageEvent } from '@nestjs/common';
import { Observable, Subject, interval, merge } from 'rxjs';
import { finalize, map, startWith } from 'rxjs/operators';

export interface NotificationStreamPayload {
  type: string;
  message: string;
  eventId: string;
}

const HEARTBEAT_INTERVAL_MS = 25000;

@Injectable()
export class NotificationsStreamService {
  private readonly logger = new Logger(NotificationsStreamService.name);
  private readonly connections = new Map<
    string,
    Set<Subject<NotificationStreamPayload>>
  >();

  subscribe(userId: string): Observable<MessageEvent> {
    const subject = new Subject<NotificationStreamPayload>();
    let userConnections = this.connections.get(userId);
    if (!userConnections) {
      userConnections = new Set();
      this.connections.set(userId, userConnections);
    }
    userConnections.add(subject);

    this.logger.log(`SSE conectado para usuario ${userId}`);

    return merge(
      subject.pipe(map((payload) => ({ data: payload }))),
      interval(HEARTBEAT_INTERVAL_MS).pipe(
        map(() => ({ data: { type: 'PING' } })),
      ),
    ).pipe(
      startWith({ data: { type: 'CONNECTED' } }),
      finalize(() => {
        userConnections.delete(subject);
        if (userConnections.size === 0) {
          this.connections.delete(userId);
        }
        subject.complete();
        this.logger.log(`SSE desconectado para usuario ${userId}`);
      }),
    );
  }

  emitToUsers(userIds: string[], payload: NotificationStreamPayload): void {
    for (const userId of userIds) {
      const userConnections = this.connections.get(userId);
      if (!userConnections) continue;
      for (const subject of userConnections) {
        subject.next(payload);
      }
    }
  }
}
