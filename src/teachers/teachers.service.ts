import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from '../auth/auth.service.js';
import { unusablePassword } from '../auth/passwords.js';
import { removeMembership, setAccountStatus } from '../auth/account-status.js';
import type { SetAccountStatusDto } from '../auth/dto/account-status.dto.js';
import type { CreateTeacherDto, UpdateTeacherDto } from './dto/teacher.dto.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import { msg } from '../i18n/i18n.js';
import type { Locale } from '../i18n/locale.js';

const teacherInclude = {
  user: { select: { id: true, fullName: true, email: true, phone: true } },
  /** The teacher's place in this center: TENANT_ADMIN when the admin teaches from their own account. */
  membership: { select: { id: true, role: true, status: true, statusReason: true } },
  _count: { select: { courses: true, students: true, sessions: true, exams: true, schedules: true, billingRates: true } },
} as const;

/**
 * A teacher with anything taught or priced under their name is part of the center's record
 * (attendance, evaluations, billing, reports), so they are suspended rather than deleted.
 * Student links alone are not a record.
 */
export const hasTeachingRecord = (c: { courses: number; sessions: number; exams: number; schedules: number; billingRates: number; students?: number }) =>
  c.courses + c.sessions + c.exams + c.schedules + c.billingRates > 0;

@Injectable()
export class TeachersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  list(tenantId: string) {
    return this.prisma.teacher.findMany({
      where: { tenantId },
      include: teacherInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(tenantId: string, id: string) {
    const teacher = await this.prisma.teacher.findFirst({ where: { id, tenantId }, include: teacherInclude });
    if (!teacher) throw new NotFoundException(msg('teachers.notFound'));
    return teacher;
  }

  /**
   * Adds a teacher to the center. An email that already has an account on the platform (a
   * teacher elsewhere, an owner of another center) joins with that account and its password;
   * otherwise a new account is created and the welcome email offers to choose a password.
   */
  async create(user: JwtUser, dto: CreateTeacherDto, locale?: Locale) {
    const tenantId = user.tenantId!;
    await this.assertQuota(tenantId);
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, memberships: { where: { tenantId }, select: { id: true } } },
    });
    if (existing?.memberships.length) throw new ConflictException(msg('users.alreadyMember'));

    const passwordHash = existing ? null : await bcrypt.hash(dto.password ?? unusablePassword(), 10);
    const teacher = await this.prisma.$transaction(async (tx) => {
      const userId =
        existing?.id ??
        (await tx.user.create({ data: { email, passwordHash: passwordHash!, fullName: dto.fullName, phone: dto.phone }, select: { id: true } })).id;
      const membership = await tx.membership.create({ data: { userId, tenantId, role: 'TEACHER' }, select: { id: true } });
      return tx.teacher.create({
        data: { tenantId, userId, membershipId: membership.id, bio: dto.bio, subjects: dto.subjects ?? [] },
        include: teacherInclude,
      });
    });
    await this.auth.sendWelcome(teacher.membershipId, { existingAccount: Boolean(existing) }, locale);
    return teacher;
  }

  /**
   * Gives the tenant admin (a solo teacher, or an owner who also teaches) a teacher profile on
   * their own account, so they teach without a second login. It counts toward the plan's teachers.
   */
  async addSelf(user: JwtUser) {
    if (user.role !== 'TENANT_ADMIN' || !user.tenantId || !user.membershipId) throw new ForbiddenException();
    if (user.teacherId) throw new ConflictException(msg('teachers.alreadyTeacher'));
    await this.assertQuota(user.tenantId);
    return this.prisma.teacher.create({
      data: { tenantId: user.tenantId, userId: user.id, membershipId: user.membershipId },
      include: teacherInclude,
    });
  }

  async update(tenantId: string, id: string, dto: UpdateTeacherDto) {
    await this.get(tenantId, id);
    const { fullName, phone, ...teacherData } = dto;
    return this.prisma.teacher.update({
      where: { id },
      data: {
        ...teacherData,
        user: { update: { fullName, phone } },
      },
      include: teacherInclude,
    });
  }

  /** Suspends (read-only), blocks (no sign-in) or reactivates the teacher in this center. See auth/account-status. */
  async setStatus(user: JwtUser, id: string, dto: SetAccountStatusDto) {
    const teacher = await this.get(user.tenantId!, id);
    // Suspending or blocking the admin's teacher profile would lock them out of the whole center.
    if (dto.status !== 'ACTIVE' && teacher.membership.role !== 'TEACHER') {
      throw new ForbiddenException(msg('teachers.adminStaysActive'));
    }
    await setAccountStatus(this.prisma, teacher.membershipId, dto, user.id);
    return this.get(user.tenantId!, id);
  }

  async remove(tenantId: string, id: string) {
    const teacher = await this.get(tenantId, id);
    if (hasTeachingRecord(teacher._count)) throw new ConflictException(msg('teachers.hasRecord'));
    // The admin keeps their membership and only stops being a teacher.
    if (teacher.membership.role !== 'TEACHER') {
      await this.prisma.teacher.delete({ where: { id } });
      return;
    }
    await removeMembership(this.prisma, teacher.membershipId);
  }

  private async assertQuota(tenantId: string) {
    const sub = await this.prisma.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
    const count = await this.prisma.teacher.count({ where: { tenantId } });
    if (sub && count >= sub.plan.maxTeachers) {
      throw new ForbiddenException(msg('teachers.quotaReached', { max: sub.plan.maxTeachers }));
    }
  }
}
