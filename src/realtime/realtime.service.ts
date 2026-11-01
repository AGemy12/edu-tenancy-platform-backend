import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { PresenceRegistry } from './presence.js';
import { chatRoom, inboxRoom, memberRoom, tenantRoom } from './rooms.js';

/**
 * Pushes events to connected clients. Services call this after their change is committed; a
 * push is a hint, never the record: clients refetch over REST when they (re)connect, so an event
 * lost to a dropped connection costs nothing but latency.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private server: Server | null = null;
  readonly presence = new PresenceRegistry();

  /** Called by the gateway once Socket.IO is up (absent in unit tests: every push is then a no-op). */
  attach(server: Server) {
    this.server = server;
  }

  /** A person's notification inbox: their space, or the platform console. */
  toInbox(target: { userId: string; membershipId: string | null }, event: string, payload: unknown) {
    this.emit([inboxRoom(target)], event, payload);
  }

  /** Every socket of these members' spaces (support mode too: send only ids, nothing private). */
  toMembers(membershipIds: Iterable<string>, event: string, payload: unknown) {
    this.emit([...new Set(membershipIds)].map(memberRoom), event, payload);
  }

  /** The chat sockets of these members (every tab and device). */
  toChat(membershipIds: Iterable<string>, event: string, payload: unknown) {
    this.emit([...new Set(membershipIds)].map(chatRoom), event, payload);
  }

  /** Every chat socket of a center (presence). */
  toTenant(tenantId: string, event: string, payload: unknown) {
    this.emit([tenantRoom(tenantId)], event, payload);
  }

  /** Closes a member's sockets now (blocked, removed): their token is no longer good. */
  disconnectMember(membershipId: string) {
    this.server?.in(memberRoom(membershipId)).disconnectSockets(true);
  }

  private emit(rooms: string[], event: string, payload: unknown) {
    if (!this.server || rooms.length === 0) return;
    try {
      this.server.to(rooms).emit(event, payload);
    } catch (err) {
      this.logger.warn(`Emitting ${event} failed: ${String(err)}`);
    }
  }
}
