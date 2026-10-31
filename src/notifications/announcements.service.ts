import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { AnnouncementAudience, Role } from '../generated/prisma/enums.js';
import type { Prisma } from '../generated/prisma/client.js';
import { msg } from '../i18n/i18n.js';
import { NotificationsService } from './notifications.service.js';
import type { CreateAnnouncementDto } from './dto/notification.dto.js';

const ROLES: Record<AnnouncementAudience, Role[] | null> = {
  EVERYONE: null,
  ADMINS: ['TENANT_ADMIN'],
  TEACHERS: ['TEACHER'],
  STUDENTS: ['STUDENT'],
};

/**
 * Announcements: a center's admin writes to its members (everyone, teachers, students, admins),
 * or the platform writes to centers (every active one, or chosen ones), with the same audiences
 * inside each. Delivered as ANNOUNCEMENT notifications; the row is the sender's record.
 */
@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(user: JwtUser, dto: CreateAnnouncementDto) {
    const platform = user.role === 'SUPER_ADMIN' && !user.tenantId;
    if (!platform && dto.tenantIds?.length) throw new BadRequestException(msg('announcements.centersOnlyPlatform'));
    const title = dto.title.trim();
    const body = dto.body.trim();
    if (!title || !body) throw new BadRequestException(msg('announcements.empty'));

    const tenants: Prisma.TenantWhereInput = platform
      ? { status: 'ACTIVE', ...(dto.tenantIds?.length && { id: { in: dto.tenantIds } }) }
      : { id: user.tenantId! };
    const roles = ROLES[dto.audience];
    const members = await this.prisma.membership.findMany({
      where: { tenant: tenants, status: { not: 'BLOCKED' }, ...(roles && { role: { in: roles } }) },
      select: { id: true },
    });
    if (members.length === 0) throw new BadRequestException(msg('announcements.noRecipients'));

    const [author, tenant] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: user.id }, select: { fullName: true } }),
      platform ? null : this.prisma.tenant.findUnique({ where: { id: user.tenantId! }, select: { name: true } }),
    ]);
    const announcement = await this.prisma.announcement.create({
      data: { tenantId: platform ? null : user.tenantId, authorId: user.id, audience: dto.audience, title, body, recipients: members.length },
    });
    await this.notifications.send({
      type: 'ANNOUNCEMENT',
      memberships: members.map((m) => m.id),
      params: { variant: platform ? 'PLATFORM' : 'CENTER', title, body, author: author?.fullName ?? '', center: tenant?.name, announcementId: announcement.id },
      actorId: user.id,
    });
    return announcement;
  }

  /** What this center (or the platform) has sent, newest first. */
  list(user: JwtUser) {
    const platform = user.role === 'SUPER_ADMIN' && !user.tenantId;
    return this.prisma.announcement.findMany({
      where: { tenantId: platform ? null : user.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, audience: true, title: true, body: true, recipients: true, createdAt: true, author: { select: { fullName: true } } },
    });
  }
}
