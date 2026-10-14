import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { CreateCourseDto, UpdateCourseDto } from './dto/course.dto.js';
import { msg } from '../i18n/i18n.js';

const courseInclude = {
  teacher: { select: { id: true, user: { select: { fullName: true } } } },
  _count: { select: { enrollments: true, sessions: true, exams: true } },
} as const;

@Injectable()
export class CoursesService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: JwtUser) {
    const tenantId = user.tenantId!;
    const where =
      user.role === 'TEACHER'
        ? { tenantId, teacherId: user.teacherId! }
        : user.role === 'STUDENT'
          ? { tenantId, enrollments: { some: { studentId: user.studentId! } } }
          : { tenantId };
    return this.prisma.course.findMany({ where, include: courseInclude, orderBy: { createdAt: 'desc' } });
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

    const { teacherId: _t, ...data } = dto;
    return this.prisma.course.create({ data: { ...data, tenantId, teacherId }, include: courseInclude });
  }

  async update(user: JwtUser, id: string, dto: UpdateCourseDto) {
    await this.getOwned(user, id);
    return this.prisma.course.update({ where: { id }, data: dto, include: courseInclude });
  }

  async remove(user: JwtUser, id: string) {
    await this.getOwned(user, id);
    await this.prisma.course.delete({ where: { id } });
  }

  async enroll(user: JwtUser, courseId: string, studentId: string) {
    const course = await this.getOwned(user, courseId);
    const student = await this.prisma.student.findFirst({ where: { id: studentId, tenantId: user.tenantId! } });
    if (!student) throw new NotFoundException(msg('students.notFound'));

    return this.prisma.$transaction(async (tx) => {
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
  }

  async unenroll(user: JwtUser, courseId: string, studentId: string) {
    await this.getOwned(user, courseId);
    await this.prisma.enrollment.deleteMany({ where: { courseId, studentId } });
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
