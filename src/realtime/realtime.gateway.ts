import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { SkipThrottle } from '@nestjs/throttler';
import type { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service.js';
import { JwtStrategy, type AccessPayload } from '../auth/jwt.strategy.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { isLocale } from '../i18n/locale.js';
import { RealtimeService } from './realtime.service.js';
import { REALTIME_PATH, RealtimeEvent, chatRoom, consoleRoom, memberRoom, tenantRoom } from './rooms.js';

type SocketData = { user: JwtUser; expiry?: NodeJS.Timeout; typingAt: Map<string, number> };
type AppSocket = Socket & { data: SocketData };

/** A typing signal is relayed at most this often per conversation and socket. */
const TYPING_EVERY_MS = 2_000;
/** Who is in a conversation, cached briefly so typing signals don't each hit the database. */
const PARTICIPANTS_TTL_MS = 30_000;
const MAX_PRESENCE_QUERY = 200;

/**
 * The real-time channel. A socket proves who it is with the same access token as the REST API
 * (`auth: { token }` in the handshake), goes through the same checks (`JwtStrategy`: membership,
 * block, suspended center, support session), and joins its rooms (see rooms.ts). The token's
 * expiry closes the socket (`auth:expired`), and the client reconnects with a fresh one, so a
 * blocked member or an ended support session never keeps a live channel for long.
 *
 * Writes (sending a message, marking read) go through REST: validated, guarded, audited. The
 * socket carries only pushes from the server and two ephemeral signals: typing and presence.
 */
@Public()
@SkipThrottle()
@WebSocketGateway({ path: REALTIME_PATH })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly participants = new Map<string, { ids: Set<string>; at: number }>();

  constructor(
    private readonly realtime: RealtimeService,
    private readonly jwt: JwtService,
    private readonly strategy: JwtStrategy,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(server: Server) {
    this.realtime.attach(server);
    // Runs before `connection`: a refused handshake reaches the client as `connect_error`.
    server.use((socket, next) => {
      this.authenticate(socket as AppSocket)
        .then(() => next())
        .catch(() => next(Object.assign(new Error('unauthorized'), { data: { code: 'unauthorized' } })));
    });
  }

  async handleConnection(socket: AppSocket) {
    const { user } = socket.data;
    if (!user) return socket.disconnect(true);
    if (!user.membershipId) {
      await socket.join(consoleRoom(user.id));
      return;
    }
    await socket.join(memberRoom(user.membershipId));
    if (user.supportSessionId) return;

    await socket.join([chatRoom(user.membershipId), tenantRoom(user.tenantId!)]);
    if (this.realtime.presence.add(user.membershipId, user.tenantId!, socket.id)) {
      this.realtime.toTenant(user.tenantId!, RealtimeEvent.presence, { membershipId: user.membershipId, online: true });
    }
  }

  async handleDisconnect(socket: AppSocket) {
    const { user, expiry } = socket.data;
    clearTimeout(expiry);
    if (!user?.membershipId || user.supportSessionId) return;
    if (!this.realtime.presence.remove(user.membershipId, socket.id)) return;

    const lastSeenAt = new Date();
    this.realtime.toTenant(user.tenantId!, RealtimeEvent.presence, { membershipId: user.membershipId, online: false, lastSeenAt });
    await this.prisma.membership
      .update({ where: { id: user.membershipId }, data: { lastSeenAt } })
      .catch((err: unknown) => this.logger.warn(`Saving last seen failed: ${String(err)}`));
  }

  /** "I am typing in this conversation": relayed to its other members, throttled. */
  @SubscribeMessage('typing')
  async typing(@ConnectedSocket() socket: AppSocket, @MessageBody() body: { conversationId?: unknown }) {
    const { user, typingAt } = socket.data;
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : null;
    if (!conversationId || !user?.membershipId || user.supportSessionId) return;

    const now = Date.now();
    if (now - (typingAt.get(conversationId) ?? 0) < TYPING_EVERY_MS) return;
    typingAt.set(conversationId, now);

    const members = await this.membersOf(conversationId, user.tenantId!);
    if (!members.has(user.membershipId)) return;
    const others = [...members].filter((id) => id !== user.membershipId);
    this.realtime.toChat(others, RealtimeEvent.typing, { conversationId, membershipId: user.membershipId });
  }

  /** Which of these members of my center are online now. */
  @SubscribeMessage('presence:query')
  presence(@ConnectedSocket() socket: AppSocket, @MessageBody() ids: unknown) {
    const { user } = socket.data;
    if (!user?.tenantId || user.supportSessionId || !Array.isArray(ids)) return { online: [] };
    const wanted = ids.filter((id): id is string => typeof id === 'string').slice(0, MAX_PRESENCE_QUERY);
    return { online: this.realtime.presence.online(wanted, user.tenantId) };
  }

  /** Same token, same checks as REST; schedules the close at the token's expiry. */
  private async authenticate(socket: AppSocket) {
    const auth = socket.handshake.auth as { token?: unknown; lang?: unknown } | undefined;
    if (typeof auth?.token !== 'string') throw new Error('no token');
    const payload = await this.jwt.verifyAsync<AccessPayload & { exp: number }>(auth.token, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
    const user = await this.strategy.validate(payload);
    socket.data = { user, typingAt: new Map() };

    const ms = payload.exp * 1000 - Date.now();
    socket.data.expiry = setTimeout(() => {
      socket.emit(RealtimeEvent.authExpired);
      socket.disconnect(true);
    }, Math.max(ms, 0));
    socket.data.expiry.unref();

    // Emails sent to this person (by others' actions) use the language they last used the app in.
    if (isLocale(auth.lang) && !user.supportSessionId) {
      await this.prisma.user.updateMany({
        where: { id: user.id, OR: [{ locale: null }, { locale: { not: auth.lang } }] },
        data: { locale: auth.lang },
      });
    }
  }

  private async membersOf(conversationId: string, tenantId: string) {
    const hit = this.participants.get(conversationId);
    if (hit && Date.now() - hit.at < PARTICIPANTS_TTL_MS) return hit.ids;
    const rows = await this.prisma.conversationParticipant.findMany({
      where: { conversationId, conversation: { tenantId } },
      select: { membershipId: true },
    });
    const ids = new Set(rows.map((r) => r.membershipId));
    this.participants.set(conversationId, { ids, at: Date.now() });
    if (this.participants.size > 5_000) this.participants.clear();
    return ids;
  }
}
