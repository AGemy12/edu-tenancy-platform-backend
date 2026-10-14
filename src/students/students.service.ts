import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from '../auth/auth.service.js';
import { unusablePassword } from '../auth/passwords.js';
import { removeMembership, setAccountStatus } from '../auth/account-status.js';
import type { SetAccountStatusDto } from '../auth/dto/account-status.dto.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { CreateStudentDto, UpdateStudentDto } from './dto/student.dto.js';
import { msg } from '../i18n/i18n.js';
import type { Locale } from '../i18n/locale.js';

const studentInclude = {
  user: { select: { id: true, fullName: true, email: true, phone: true } },
  /** The student's place in this center. */
  membership: { select: { id: true, role: true, status: true, statusReason: true } },
  teachers: { select: { teacher: { select: { id: true, user: { select: { fullName: true } } } } } },
  _count: { select: { enrollments: true, attendances: true, examResults: true, schedules: true, billingRates: true } },
} as const;

/**
 * A student who was ever in a session, graded, scheduled, priced or enrolled is part of the
 * center's record (attendance, evaluations, billing, reports), so they are suspended rather
 * than deleted. Teacher links alone are not a record.
 */
export const hasStudyRecord = (c: { enrollments: number; attendances: number; examResults: number; schedules: number; billingRates: number }) =>
  c.enrollments + c.attendances + c.examResults + c.schedules + c.billingRates > 0;

@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  list(user: JwtUser) {
    const tenantId = user.tenantId!;
    const where =
      user.role === 'TEACHER' && user.teacherId
        ? { tenantId, teachers: { some: { teacherId: user.teacherId } } }
        : { tenantId };
    return this.prisma.student.findMany({ where, include: studentInclude, orderBy: { createdAt: 'desc' } });
  }

  async get(user: JwtUser, id: string) {
    const student = await this.prisma.student.findFirst({
      where: { id, tenantId: user.tenantId! },
      include: studentInclude,
    });
    if (!student) throw new NotFoundException(msg('students.notFound'));
    if (user.role === 'TEACHER' && !student.teachers.some((t) => t.teacher.id === user.teacherId)) {
      throw new ForbiddenException();
    }
    return student;
  }

  /**
   * Adds a student to the center. An email that already has an account on the platform joins
   * with that account and its password; otherwise a new account is created and the welcome
   * email offers to choose a password.
   */
  async create(user: JwtUser, dto: CreateStudentDto, locale?: Locale) {
    const tenantId = user.tenantId!;
    await this.assertQuota(tenantId);
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, memberships: { where: { tenantId }, select: { id: true } } },
    });
    if (existing?.memberships.length) throw new ConflictException(msg('users.alreadyMember'));

    const teacherId = user.role === 'TEACHER' ? user.teacherId! : dto.teacherId;
    if (teacherId) {
      const teacher = await this.prisma.teacher.findFirst({ where: { id: teacherId, tenantId } });
      if (!teacher) throw new NotFoundException(msg('teachers.notFound'));
    }

    const passwordHash = existing ? null : await bcrypt.hash(dto.password ?? unusablePassword(), 10);
    const student = await this.prisma.$transaction(async (tx) => {
      const userId =
        existing?.id ??
        (await tx.user.create({ data: { email, passwordHash: passwordHash!, fullName: dto.fullName, phone: dto.phone }, select: { id: true } })).id;
      const membership = await tx.membership.create({ data: { userId, tenantId, role: 'STUDENT' }, select: { id: true } });
      return tx.student.create({
        data: {
          tenantId,
          userId,
          membershipId: membership.id,
          grade: dto.grade,
          parentPhone: dto.parentPhone,
          notes: dto.notes,
          ...(teacherId ? { teachers: { create: { teacherId } } } : {}),
        },
        include: studentInclude,
      });
    });
    await this.auth.sendWelcome(student.membershipId, { existingAccount: Boolean(existing) }, locale);
    return student;
  }

  async update(user: JwtUser, id: string, dto: UpdateStudentDto) {
    await this.get(user, id);
    const { fullName, phone, ...studentData } = dto;
    return this.prisma.student.update({
      where: { id },
      data: { ...studentData, user: { update: { fullName, phone } } },
      include: studentInclude,
    });
  }

  /**
   * Suspends (read-only), blocks (no sign-in) or reactivates the student in this center. Admins
   * for any student, teachers for their own (`get` scopes it). See auth/account-status.
   */
  async setStatus(user: JwtUser, id: string, dto: SetAccountStatusDto) {
    const student = await this.get(user, id);
    await setAccountStatus(this.prisma, student.membershipId, dto, user.id);
    return this.get(user, id);
  }

  async linkTeacher(user: JwtUser, studentId: string, teacherId: string) {
    const student = await this.get(user, studentId);
    const teacher = await this.prisma.teacher.findFirst({ where: { id: teacherId, tenantId: user.tenantId! } });
    if (!teacher) throw new NotFoundException(msg('teachers.notFound'));
    await this.prisma.teacherStudent.upsert({
      where: { teacherId_studentId: { teacherId, studentId: student.id } },
      update: {},
      create: { teacherId, studentId: student.id },
    });
    return this.get(user, studentId);
  }

  async unlinkTeacher(user: JwtUser, studentId: string, teacherId: string) {
    await this.get(user, studentId);
    await this.prisma.teacherStudent.deleteMany({ where: { teacherId, studentId } });
  }

  async remove(user: JwtUser, id: string) {
    const student = await this.get(user, id);
    if (hasStudyRecord(student._count)) throw new ConflictException(msg('students.hasRecord'));
    await removeMembership(this.prisma, student.membershipId);
  }

  private async assertQuota(tenantId: string) {
    const sub = await this.prisma.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
    const count = await this.prisma.student.count({ where: { tenantId } });
    if (sub && count >= sub.plan.maxStudents) {
      throw new ForbiddenException(msg('students.quotaReached', { max: sub.plan.maxStudents }));
    }
  }
}
