import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { CreateCourseDto, UpdateCourseDto } from './dto/course.dto.js';
import { msg } from '../i18n/i18n.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { PricesService } from '../billing/prices.service.js';

const courseInclude = {
  teacher: { select: { id: true, user: { select: { fullName: true } } } },
  _count: { select: { enrollments: true, sessions: true, exams: true, schedules: true } },
} as const;

/**
 * Sessions, exams and schedules are recorded under the course's teacher (attendance, marks, pay,
 * reports), so a course keeps its teacher once it has any. Before that, it can go to another one.
 */
export const canChangeTeacher = (c: { sessions: number; exams: number; schedules: number }) => c.sessions + c.exams + c.schedules === 0;

@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    private readonly prices: PricesService,
  ) {}

  async list(user: JwtUser) {
    const tenantId = user.tenantId!;
    const where =
      user.role === 'TEACHER'
        ? { tenantId, teacherId: user.teacherId! }
        : user.role === 'STUDENT'
          ? { tenantId, enrollments: { some: { studentId: user.studentId! } } }
          : { tenantId };
    const courses = await this.prisma.course.findMany({ where, include: courseInclude, orderBy: { createdAt: 'desc' } });
    return this.withPrices(user, courses);
  }

  /** Admins and teachers see each course's session price; a student's own price may differ, so they don't. */
  private async withPrices<T extends { id: string }>(user: JwtUser, courses: T[]) {
    if (user.role === 'STUDENT') return courses;
    const prices = await this.prices.coursePrices(user.tenantId!);
    return courses.map((c) => ({ ...c, sessionPrice: prices.get(c.id) ?? null }));
  }

  async get(user: JwtUser, id: string) {
    const course = await this.prisma.course.findFirst({
      where: { id, tenantId: user.tenantId! },
      include: {
        ...courseInclude,
        enrollments: {
          include: { student: { select: { id: true, user: { select: { fullName: true, email: true } } } } },
        },
      },
    });
    if (!course) throw new NotFoundException(msg('courses.notFound'));
    this.assertAccess(user, course.teacherId, course.enrollments.map((e) => e.studentId));
    return course;
  }

  async create(user: JwtUser, dto: CreateCourseDto) {
    const tenantId = user.tenantId!;
    const teacherId = user.role === 'TEACHER' ? user.teacherId! : dto.teacherId;
    if (!teacherId) throw new BadRequestException(msg('teachers.required'));
    const teacher = await this.prisma.teacher.findFirst({ where: { id: teacherId, tenantId } });
    if (!teacher) throw new NotFoundException(msg('teachers.notFound'));

    const { teacherId: _t, sessionPrice, ...data } = dto;
    assertCanPrice(user, sessionPrice);
    const course = await this.prisma.course.create({ data: { ...data, tenantId, teacherId }, include: courseInclude });
    await this.savePrice(user, course.id, sessionPrice);
    return (await this.withPrices(user, [course]))[0];
  }

  async update(user: JwtUser, id: string, dto: UpdateCourseDto) {
    const before = await this.getOwned(user, id);
    const { sessionPrice, teacherId, ...data } = dto;
    assertCanPrice(user, sessionPrice);
    const newTeacher = teacherId && teacherId !== before.teacherId ? await this.newTeacher(user, id, teacherId) : null;

    const course = await this.prisma.$transaction(async (tx) => {
      if (newTeacher) {
        // As when enrolling: the course's students become the new teacher's students.
        const enrolled = await tx.enrollment.findMany({ where: { courseId: id }, select: { studentId: true } });
        await tx.teacherStudent.createMany({ data: enrolled.map((e) => ({ teacherId: newTeacher.id, studentId: e.studentId })), skipDuplicates: true });
      }
      return tx.course.update({ where: { id }, data: { ...data, ...(newTeacher && { teacherId: newTeacher.id }) }, include: courseInclude });
    });
    await this.savePrice(user, id, sessionPrice);
    if (newTeacher) void this.messaging.courseTeacherChanged(id, newTeacher.membershipId);
    return (await this.withPrices(user, [course]))[0];
  }

  /** The teacher a course may be handed to: the admin's call, and only before anything was taught in it. */
  private async newTeacher(user: JwtUser, courseId: string, teacherId: string) {
    if (user.role !== 'TENANT_ADMIN') throw new ForbiddenException(msg('courses.teacherByCenter'));
    const counts = await this.prisma.course.findUniqueOrThrow({ where: { id: courseId }, select: { _count: { select: { sessions: true, exams: true, schedules: true } } } });
    if (!canChangeTeacher(counts._count)) throw new ConflictException(msg('courses.teacherLocked'));
    const teacher = await this.prisma.teacher.findFirst({ where: { id: teacherId, tenantId: user.tenantId! }, select: { id: true, membershipId: true } });
    if (!teacher) throw new NotFoundException(msg('teachers.notFound'));
    return teacher;
  }

  private async savePrice(user: JwtUser, courseId: string, price: number | null | undefined) {
    if (price === undefined) return;
    await this.prices.setCoursePrice(user.tenantId!, courseId, price);
  }

  async remove(user: JwtUser, id: string) {
    await this.getOwned(user, id);
    await this.prisma.course.delete({ where: { id } });
  }

  async enroll(user: JwtUser, courseId: string, studentId: string) {
    const course = await this.getOwned(user, courseId);
    const student = await this.prisma.student.findFirst({ where: { id: studentId, tenantId: user.tenantId! } });
    if (!student) throw new NotFoundException(msg('students.notFound'));

    const enrollment = await this.prisma.$transaction(async (tx) => {
      // Enrolling also links the student to the course teacher.
      await tx.teacherStudent.upsert({
        where: { teacherId_studentId: { teacherId: course.teacherId, studentId } },
        update: {},
        create: { teacherId: course.teacherId, studentId },
      });
      return tx.enrollment.upsert({
        where: { courseId_studentId: { courseId, studentId } },
        update: { status: 'ACTIVE' },
        create: { tenantId: user.tenantId!, courseId, studentId },
      });
    });
    void this.messaging.courseEnrollmentChanged(courseId, studentId, true);
    return enrollment;
  }

  async unenroll(user: JwtUser, courseId: string, studentId: string) {
    await this.getOwned(user, courseId);
    await this.prisma.enrollment.deleteMany({ where: { courseId, studentId } });
    void this.messaging.courseEnrollmentChanged(courseId, studentId, false);
  }

  /** Course the caller may manage (admin: any in tenant; teacher: own). */
  async getOwned(user: JwtUser, id: string) {
    const course = await this.prisma.course.findFirst({ where: { id, tenantId: user.tenantId! } });
    if (!course) throw new NotFoundException(msg('courses.notFound'));
    if (user.role === 'TEACHER' && course.teacherId !== user.teacherId) throw new ForbiddenException();
    return course;
  }

  private assertAccess(user: JwtUser, teacherId: string, studentIds: string[]) {
    if (user.role === 'TEACHER' && teacherId !== user.teacherId) throw new ForbiddenException();
    if (user.role === 'STUDENT' && !studentIds.includes(user.studentId!)) throw new ForbiddenException();
  }
}

/** The center sets prices: a teacher's course gets its price from the admin. */
function assertCanPrice(user: JwtUser, price: number | null | undefined) {
  if (price !== undefined && user.role !== 'TENANT_ADMIN') throw new ForbiddenException(msg('billing.pricesByCenter'));
}
