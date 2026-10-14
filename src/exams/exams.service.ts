import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { CreateExamDto, GradeDto, GradeManyDto, UpdateExamDto } from './dto/exam.dto.js';
import { msg } from '../i18n/i18n.js';

const examInclude = {
  course: { select: { id: true, title: true } },
  teacher: { select: { id: true, user: { select: { fullName: true } } } },
  _count: { select: { results: true } },
} as const;

export function startOfMonth(input: string | Date) {
  const d = new Date(input);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

@Injectable()
export class ExamsService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: JwtUser, month?: string) {
    const tenantId = user.tenantId!;
    const scope =
      user.role === 'TEACHER'
        ? { teacherId: user.teacherId! }
        : user.role === 'STUDENT'
          ? { status: { not: 'DRAFT' as const }, course: { enrollments: { some: { studentId: user.studentId! } } } }
          : {};
    return this.prisma.exam.findMany({
      where: { tenantId, ...scope, ...(month ? { month: startOfMonth(month) } : {}) },
      // Students also get their own mark.
      include:
        user.role === 'STUDENT'
          ? { ...examInclude, results: { where: { studentId: user.studentId! }, select: { score: true, feedback: true } } }
          : examInclude,
      orderBy: [{ month: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async get(user: JwtUser, id: string) {
    const exam = await this.prisma.exam.findFirst({
      where: { id, tenantId: user.tenantId! },
      include: {
        ...examInclude,
        results: {
          where: user.role === 'STUDENT' ? { studentId: user.studentId! } : {},
          include: { student: { select: { id: true, user: { select: { fullName: true } } } } },
        },
      },
    });
    if (!exam) throw new NotFoundException(msg('exams.notFound'));
    if (user.role === 'TEACHER' && exam.teacherId !== user.teacherId) throw new ForbiddenException();
    if (user.role === 'STUDENT') {
      if (exam.status === 'DRAFT') throw new ForbiddenException();
      const enrolled = await this.prisma.enrollment.findUnique({
        where: { courseId_studentId: { courseId: exam.courseId, studentId: user.studentId! } },
      });
      if (!enrolled) throw new ForbiddenException();
    }
    return exam;
  }

  async create(user: JwtUser, dto: CreateExamDto) {
    const tenantId = user.tenantId!;
    const course = await this.prisma.course.findFirst({ where: { id: dto.courseId, tenantId } });
    if (!course) throw new NotFoundException(msg('courses.notFound'));
    if (user.role === 'TEACHER' && course.teacherId !== user.teacherId) throw new ForbiddenException();

    return this.prisma.exam.create({
      data: {
        tenantId,
        courseId: course.id,
        teacherId: course.teacherId,
        title: dto.title,
        description: dto.description,
        month: startOfMonth(dto.month),
        totalMarks: dto.totalMarks ?? 100,
      },
      include: examInclude,
    });
  }

  async update(user: JwtUser, id: string, dto: UpdateExamDto) {
    await this.getOwned(user, id);
    return this.prisma.exam.update({
      where: { id },
      data: { ...dto, month: dto.month ? startOfMonth(dto.month) : undefined },
      include: examInclude,
    });
  }

  async remove(user: JwtUser, id: string) {
    await this.getOwned(user, id);
    await this.prisma.exam.delete({ where: { id } });
  }

  async grade(user: JwtUser, id: string, dto: GradeDto) {
    const exam = await this.getOwned(user, id);
    if (dto.score > exam.totalMarks) {
      throw new BadRequestException(msg('exams.markExceedsTotal', { total: exam.totalMarks }));
    }
    const enrolled = await this.prisma.enrollment.findUnique({
      where: { courseId_studentId: { courseId: exam.courseId, studentId: dto.studentId } },
    });
    if (!enrolled) throw new NotFoundException(msg('exams.studentNotEnrolled'));

    return this.prisma.examResult.upsert({
      where: { examId_studentId: { examId: id, studentId: dto.studentId } },
      update: { score: dto.score, feedback: dto.feedback, gradedAt: new Date() },
      create: { examId: id, studentId: dto.studentId, score: dto.score, feedback: dto.feedback },
      include: { student: { select: { id: true, user: { select: { fullName: true } } } } },
    });
  }

  /** Grading sheet: every student enrolled in the exam's course, with their mark so far. */
  async roster(user: JwtUser, id: string) {
    const exam = await this.getOwned(user, id);
    const [enrollments, results] = await Promise.all([
      this.prisma.enrollment.findMany({
        where: { courseId: exam.courseId },
        select: { studentId: true, student: { select: { user: { select: { fullName: true } } } } },
        orderBy: { student: { user: { fullName: 'asc' } } },
      }),
      this.prisma.examResult.findMany({ where: { examId: id } }),
    ]);
    const byStudent = new Map(results.map((r) => [r.studentId, r]));
    return enrollments.map((e) => {
      const r = byStudent.get(e.studentId);
      return {
        studentId: e.studentId,
        name: e.student.user.fullName,
        score: r ? Number(r.score) : null,
        feedback: r?.feedback ?? null,
      };
    });
  }

  /** Saves several marks at once (all or nothing). */
  async gradeMany(user: JwtUser, id: string, dto: GradeManyDto) {
    const exam = await this.getOwned(user, id);
    const ids = dto.results.map((r) => r.studentId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException(msg('exams.duplicateStudent'));
    const over = dto.results.find((r) => r.score > exam.totalMarks);
    if (over) throw new BadRequestException(msg('exams.markExceedsTotal', { total: exam.totalMarks }));
    const enrolled = await this.prisma.enrollment.count({ where: { courseId: exam.courseId, studentId: { in: ids } } });
    if (enrolled !== ids.length) throw new NotFoundException(msg('exams.studentNotEnrolled'));

    const now = new Date();
    await this.prisma.$transaction(
      dto.results.map((r) =>
        this.prisma.examResult.upsert({
          where: { examId_studentId: { examId: id, studentId: r.studentId } },
          update: { score: r.score, feedback: r.feedback ?? null, gradedAt: now },
          create: { examId: id, studentId: r.studentId, score: r.score, feedback: r.feedback },
        }),
      ),
    );
    return this.roster(user, id);
  }

  private async getOwned(user: JwtUser, id: string) {
    const exam = await this.prisma.exam.findFirst({ where: { id, tenantId: user.tenantId! } });
    if (!exam) throw new NotFoundException(msg('exams.notFound'));
    if (user.role === 'TEACHER' && exam.teacherId !== user.teacherId) throw new ForbiddenException();
    return exam;
  }
}
