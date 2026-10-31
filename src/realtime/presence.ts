/**
 * Who is connected right now, per membership: a member is online while at least one of their
 * chat sockets (tab, device) is open. In memory, so it holds for one API process; running several
 * behind a load balancer needs the Socket.IO Redis adapter and a shared registry instead.
 */
export class PresenceRegistry {
  private readonly members = new Map<string, { tenantId: string; sockets: Set<string> }>();

  /** Adds a socket; true when it brings the member online. */
  add(membershipId: string, tenantId: string, socketId: string): boolean {
    const entry = this.members.get(membershipId);
    if (entry) {
      entry.sockets.add(socketId);
      return false;
    }
    this.members.set(membershipId, { tenantId, sockets: new Set([socketId]) });
    return true;
  }

  /** Removes a socket; true when it was the member's last one (now offline). */
  remove(membershipId: string, socketId: string): boolean {
    const entry = this.members.get(membershipId);
    if (!entry?.sockets.delete(socketId)) return false;
    if (entry.sockets.size > 0) return false;
    this.members.delete(membershipId);
    return true;
  }

  isOnline(membershipId: string) {
    return this.members.has(membershipId);
  }

  /** Of `ids`, those online in `tenantId` (a center never learns about another's members). */
  online(ids: readonly string[], tenantId: string): string[] {
    return ids.filter((id) => this.members.get(id)?.tenantId === tenantId);
  }
}
