import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { RealtimeEvent } from '../realtime/rooms.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { NotificationCategory, NotificationType } from '../generated/prisma/enums.js';
import type { Prisma } from '../generated/prisma/client.js';
import { isLocale, type Locale } from '../i18n/locale.js';
import { msg } from '../i18n/i18n.js';
import { CATEGORIES, NOTIFICATION_TYPES, categoryOf, channelsFor, preferencesFor } from './notification-catalog.js';
import type { ListNotificationsQueryDto, PreferenceDto } from './dto/notification.dto.js';

export type NotifyParams = Record<string, string | number | null | undefined>;

export type NotifyInput = {
  type: NotificationType;
  /** Center members, by membership id; each is told in that center. */
  memberships?: string[];
  /** Every platform admin, in the console. */
  platformAdmins?: boolean;
  /** These platform admins (user ids), in the console. */
  consoleUsers?: string[];
  /** Template values. Dates go as ISO strings; `variant` picks one of the type's texts. */
  params?: NotifyParams;
  /** In-app path without the locale (/dashboard/sessions). */
  link?: string | null;
  /** Who did it: never told about their own action. */
  actorId?: string | null;
  /** Makes the event idempotent: at most one notification per recipient for this key. */
  dedupe?: string;
  /** The center admins' third-person copy of an event that concerned others (category ACTIVITY). */
  oversight?: boolean;
};

type Recipient = {
  userId: string;
  membershipId: string | null;
  tenantId: string | null;
  email: string;
  fullName: string;
  locale: string | null;
  tenant: { name: string; timezone: string } | null;
};

const notificationSelect = {
  id: true,
  userId: true,
  membershipId: true,
  type: true,
  params: true,
  link: true,
  oversight: true,
  readAt: true,
  createdAt: true,
  actor: { select: { fullName: true } },
} as const;

type Row = Prisma.NotificationGetPayload<{ select: typeof notificationSelect }>;

/** Rows written per statement when a notice goes to many people (an announcement). */
const BATCH = 500;
const PAGE = 20;

/**
 * Notifications: one row per recipient (the record), pushed live to their open tabs, and emailed
 * when the type allows and the person wants it. `send` never throws: whatever triggered it has
 * already happened, and a lost notification must not undo it.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /** Delivers one event to its recipients; resolves to how many were notified in-app. */
  async send(input: NotifyInput): Promise<number> {
    try {
      return await this.deliver(input);
    } catch (err) {
      this.logger.warn(`Notification ${input.type} failed: ${String(err)}`);
      return 0;
    }
  }

  private async deliver(input: NotifyInput) {
    const recipients = (await this.resolve(input)).filter((r) => r.userId !== input.actorId);
    if (recipients.length === 0) return 0;

    const oversight = input.oversight ?? false;
    const category = categoryOf(input.type, oversight);
    const saved = await this.prisma.notificationPreference.findMany({
      where: { userId: { in: [...new Set(recipients.map((r) => r.userId))] }, category },
      select: { userId: true, inApp: true, email: true },
    });
    const prefs = new Map(saved.map((p) => [p.userId, p]));
    const routed = recipients.map((r) => ({ r, ...channelsFor(input.type, prefs.get(r.userId), oversight) }));
    const params = Object.fromEntries(Object.entries(input.params ?? {}).filter(([, v]) => v !== undefined && v !== null)) as Record<string, string | number>;

    const rows: Row[] = [];
    const inApp = routed.filter((x) => x.inApp).map((x) => x.r);
    for (let i = 0; i < inApp.length; i += BATCH) {
      const created = await this.prisma.notification.createManyAndReturn({
        data: inApp.slice(i, i + BATCH).map((r) => ({
          userId: r.userId,
          membershipId: r.membershipId,
          tenantId: r.tenantId,
          type: input.type,
          params,
          link: input.link ?? null,
          actorId: input.actorId ?? null,
          oversight,
          dedupeKey: input.dedupe ? `${input.dedupe}:${r.membershipId ?? r.userId}` : null,
        })),
        // A key seen before means that person was already told.
        skipDuplicates: true,
        select: { id: true, userId: true, membershipId: true, type: true, params: true, link: true, oversight: true, readAt: true, createdAt: true },
      });
      rows.push(...created.map((c) => ({ ...c, actor: null })));
    }

    const actor = input.actorId
      ? await this.prisma.user.findUnique({ where: { id: input.actorId }, select: { fullName: true } })
      : null;
    for (const row of rows) {
      this.realtime.toInbox(row, RealtimeEvent.notificationNew, { notification: present({ ...row, actor }) });
    }

    const told = new Set(rows.map((r) => `${r.userId}:${r.membershipId}`));
    const emails = routed
      .filter((x) => x.email && (!input.dedupe || !x.inApp || told.has(`${x.r.userId}:${x.r.membershipId}`)))
      .map((x) => x.r);
    if (emails.length) void this.email(input, params, emails);
    return rows.length;
  }

  /** Accounts behind the targets. Blocked members can't see anything, so only their own account news reaches them. */
  private async resolve(input: NotifyInput): Promise<Recipient[]> {
    const out: Recipient[] = [];
    const ids = [...new Set(input.memberships ?? [])];
    if (ids.length) {
      const members = await this.prisma.membership.findMany({
        where: { id: { in: ids }, ...(input.type !== 'ACCOUNT_STATUS' && { status: { not: 'BLOCKED' } }) },
        select: {
          id: true,
          tenantId: true,
          user: { select: { id: true, email: true, fullName: true, locale: true } },
          tenant: { select: { name: true, timezone: true } },
        },
      });
      for (const m of members) {
        out.push({ userId: m.user.id, membershipId: m.id, tenantId: m.tenantId, email: m.user.email, fullName: m.user.fullName, locale: m.user.locale, tenant: m.tenant });
      }
    }
    if (input.platformAdmins || input.consoleUsers?.length) {
      const admins = await this.prisma.user.findMany({
        where: { isPlatformAdmin: true, ...(!input.platformAdmins && { id: { in: input.consoleUsers } }) },
        select: { id: true, email: true, fullName: true, locale: true },
      });
      for (const a of admins) {
        out.push({ userId: a.id, membershipId: null, tenantId: null, email: a.email, fullName: a.fullName, locale: a.locale, tenant: null });
      }
    }
    return out;
  }

  /** One email each, in the recipient's language; failures are logged and skipped. */
  private async email(input: NotifyInput, params: Record<string, string | number>, recipients: Recipient[]) {
    const appUrl = (this.config.get<string>('APP_URL') ?? 'http://localhost:3000').replace(/\/$/, '');
    for (const r of recipients) {
      const locale: Locale = isLocale(r.locale) ? r.locale : 'ar';
      try {
        await this.mail.sendNotification(
          {
            to: r.email,
            fullName: r.fullName,
            type: input.type,
            params,
            timezone: r.tenant?.timezone ?? 'UTC',
            url: `${appUrl}/${locale}${input.link ?? '/dashboard/notifications'}`,
            settingsUrl: `${appUrl}/${locale}/dashboard/notifications?tab=preferences`,
          },
          locale,
        );
      } catch (err) {
        this.logger.warn(`Notification email (${input.type}) to user ${r.userId} failed: ${String(err)}`);
      }
    }
  }

  /* ── The signed-in person's inbox (this space, or the console) ── */

  private mine(user: JwtUser): Prisma.NotificationWhereInput {
    return { userId: user.id, membershipId: user.membershipId };
  }

  async list(user: JwtUser, q: ListNotificationsQueryDto) {
    const take = q.take ?? PAGE;
    const where: Prisma.NotificationWhereInput = {
      ...this.mine(user),
      ...(q.unread && { readAt: null }),
      ...(q.category && inCategory(q.category)),
    };
    const rows = await this.prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
      select: notificationSelect,
    });
    const more = rows.length > take;
    const items = rows.slice(0, take).map(present);
    return { items, nextCursor: more ? items[items.length - 1].id : null, unread: await this.unread(user) };
  }

  unread(user: JwtUser) {
    return this.prisma.notification.count({ where: { ...this.mine(user), readAt: null } });
  }

  async markRead(user: JwtUser, ids: string[]) {
    await this.prisma.notification.updateMany({ where: { ...this.mine(user), id: { in: ids }, readAt: null }, data: { readAt: new Date() } });
    return this.changed(user, { read: ids });
  }

  async markAllRead(user: JwtUser, category?: NotificationCategory) {
    await this.prisma.notification.updateMany({
      where: { ...this.mine(user), readAt: null, ...(category && inCategory(category)) },
      data: { readAt: new Date() },
    });
    return this.changed(user, { allRead: true, category: category ?? null });
  }

  async remove(user: JwtUser, id: string) {
    await this.prisma.notification.deleteMany({ where: { ...this.mine(user), id } });
    return this.changed(user, { removed: [id] });
  }

  /** Tells the person's other tabs and devices, with the new unread count. */
  private async changed(user: JwtUser, change: Record<string, unknown>) {
    const unread = await this.unread(user);
    this.realtime.toInbox({ userId: user.id, membershipId: user.membershipId }, RealtimeEvent.notificationChanged, { ...change, unread });
    return { unread };
  }

  /* ── Preferences (per person, every space) ── */

  async preferences(user: JwtUser) {
    const saved = await this.prisma.notificationPreference.findMany({
      where: { userId: user.id },
      select: { category: true, inApp: true, email: true },
    });
    return preferencesFor(user.role, saved);
  }

  async setPreferences(user: JwtUser, items: PreferenceDto[]) {
    for (const p of items) {
      if (!CATEGORIES[p.category].roles.includes(user.role)) throw new BadRequestException(msg('notifications.categoryNotAllowed'));
    }
    await this.prisma.$transaction(
      items.map((p) =>
        this.prisma.notificationPreference.upsert({
          where: { userId_category: { userId: user.id, category: p.category } },
          update: { inApp: p.inApp, email: p.email },
          create: { userId: user.id, category: p.category, inApp: p.inApp, email: p.email },
        }),
      ),
    );
    return this.preferences(user);
  }
}

export function typesOf(category: NotificationCategory) {
  return (Object.keys(NOTIFICATION_TYPES) as NotificationType[]).filter((t) => NOTIFICATION_TYPES[t].category === category);
}

/** Notifications filed under a category: center activity is every oversight copy, whatever its type. */
export function inCategory(category: NotificationCategory): Prisma.NotificationWhereInput {
  return category === 'ACTIVITY' ? { oversight: true } : { oversight: false, type: { in: typesOf(category) } };
}

/** The API shape of a notification. */
export function present(row: Row) {
  return {
    id: row.id,
    type: row.type,
    category: categoryOf(row.type, row.oversight),
    oversight: row.oversight,
    params: row.params,
    link: row.link,
    readAt: row.readAt,
    createdAt: row.createdAt,
    actor: row.actor ? { fullName: row.actor.fullName } : null,
  };
}
