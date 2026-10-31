import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationEvents } from './notification-events.js';
import { RETENTION_DAYS, REMINDER_LEAD_MIN, SUBSCRIPTION_NOTICE_DAYS, subscriptionNotice } from './notification-schedule.js';

const MINUTE = 60_000;

/**
 * Notices nobody triggers by hand: sessions starting soon, subscriptions running out, and the
 * clean-up of old notifications. Each notice is claimed with a conditional update before it is
 * sent (`reminderSentAt`, `expiryNotice`), so it goes out once even with several API processes.
 */
@Injectable()
export class NotificationJobs implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationJobs.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: NotificationEvents,
  ) {}

  onModuleInit() {
    this.every('reminders', MINUTE, () => this.sessionReminders());
    this.every('subscriptions', 15 * MINUTE, () => this.subscriptionNotices());
    this.every('cleanup', 6 * 60 * MINUTE, () => this.cleanup());
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }

  /** Students and the teacher, once, when a session is about to start. */
  async sessionReminders(now = new Date()) {
    const soon = await this.prisma.session.findMany({
      where: { status: 'SCHEDULED', reminderSentAt: null, startAt: { gt: now, lte: new Date(now.getTime() + REMINDER_LEAD_MIN * MINUTE) } },
      select: { id: true, startAt: true, createdAt: true },
      take: 500,
    });
    for (const s of soon) {
      const claimed = await this.prisma.session.updateMany({ where: { id: s.id, reminderSentAt: null }, data: { reminderSentAt: now } });
      if (claimed.count === 0) continue;
      // Booked inside the window: the "scheduled" notice just went out, a reminder would repeat it.
      if (s.startAt.getTime() - s.createdAt.getTime() <= REMINDER_LEAD_MIN * MINUTE) continue;
      await this.events.sessionReminder(s.id, Math.max(Math.round((s.startAt.getTime() - now.getTime()) / MINUTE), 1));
    }
  }

  /** The center's admins, a few days before the period ends and once it has. */
  async subscriptionNotices(now = new Date()) {
    const subs = await this.prisma.subscription.findMany({
      where: {
        status: { not: 'CANCELED' },
        currentPeriodEnd: { not: null, lte: new Date(now.getTime() + SUBSCRIPTION_NOTICE_DAYS * 24 * 60 * MINUTE) },
        tenant: { status: 'ACTIVE' },
      },
      select: { tenantId: true, currentPeriodEnd: true, tenant: { select: { expiryNotice: true } } },
    });
    for (const sub of subs) {
      const notice = subscriptionNotice(sub.currentPeriodEnd!, now);
      if (!notice || sub.tenant.expiryNotice === notice.key) continue;
      const claimed = await this.prisma.tenant.updateMany({
        where: { id: sub.tenantId, OR: [{ expiryNotice: null }, { expiryNotice: { not: notice.key } }] },
        data: { expiryNotice: notice.key },
      });
      if (claimed.count) await this.events.subscriptionNotice(sub.tenantId, notice.kind, sub.currentPeriodEnd!);
    }
  }

  /** Notifications are news, not records: old ones go. */
  async cleanup(now = new Date()) {
    const { count } = await this.prisma.notification.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * MINUTE) } },
    });
    if (count) this.logger.log(`Removed ${count} notifications older than ${RETENTION_DAYS} days`);
  }

  /** Runs `job` now and then every `ms`, never two runs of the same job at once. */
  private every(name: string, ms: number, job: () => Promise<void>) {
    const run = async () => {
      if (this.running.has(name)) return;
      this.running.add(name);
      try {
        await job();
      } catch (err) {
        this.logger.warn(`Job ${name} failed: ${String(err)}`);
      } finally {
        this.running.delete(name);
      }
    };
    void run();
    const timer = setInterval(() => void run(), ms);
    timer.unref();
    this.timers.push(timer);
  }
}
