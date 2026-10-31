/**
 * Socket.IO rooms. A socket joins rooms when it connects (from its verified JWT), and the API
 * emits to rooms, never to sockets, so every tab and device of a person gets the event.
 *
 * - `m:<membershipId>`: notifications of one space (also joined in support mode: the admin sees
 *   what the member is told, but nothing private).
 * - `u:<userId>`: notifications of the platform console (no membership).
 * - `chat:<membershipId>`: messages, typing and read receipts. Never joined in support mode:
 *   a member's conversations are theirs, not the center's.
 * - `t:<tenantId>`: presence of the center's members (who is online), for chat sockets only.
 */
export const memberRoom = (membershipId: string) => `m:${membershipId}`;
export const consoleRoom = (userId: string) => `u:${userId}`;
export const chatRoom = (membershipId: string) => `chat:${membershipId}`;
export const tenantRoom = (tenantId: string) => `t:${tenantId}`;

/** Where a person's notifications go: their space, or the console when they have none. */
export function inboxRoom(target: { userId: string; membershipId: string | null }) {
  return target.membershipId ? memberRoom(target.membershipId) : consoleRoom(target.userId);
}

/** Server → client events. */
export const RealtimeEvent = {
  notificationNew: 'notification:new',
  /** Read, dismissed, or read-all (another tab or device of the same person). */
  notificationChanged: 'notification:changed',
  messageNew: 'message:new',
  messageUpdated: 'message:updated',
  conversationUpdated: 'conversation:updated',
  conversationRead: 'conversation:read',
  conversationRemoved: 'conversation:removed',
  typing: 'typing',
  presence: 'presence',
  /** The access token ran out: refresh it and reconnect. */
  authExpired: 'auth:expired',
} as const;

/** The socket path, under the API prefix so one reverse-proxy rule covers both. */
export const REALTIME_PATH = '/api/realtime';
