import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';

export type MonthlyStudentReport = {
  studentId: string;
  studentName: string;
  month: string;
  sessionsTotal: number;
  sessionsAttended: number;
  /** Attended, but late (from the teachers' session evaluations). */
  sessionsLate: number;
  attendanceRate: number;
  /** Mean of the teachers' session ratings (1–10), when any were given. */
  averageRating: number | null;
  examsCount: number;
  averageScore: number | null; // percentage 0..100
};

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Monthly report per student: attendance over sessions in the month and
   * average exam score (as a percentage of each exam's total marks).
   * `month` is "YYYY-MM".
   */
  async monthly(user: JwtUser, month: string): Promise<MonthlyStudentReport[]> {
    const tenantId = user.tenantId!;
    const [y, m] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1));
    const to = new Date(Date.UTC(y, m, 1));

    const studentWhere =
      user.role === 'TEACHER'
        ? { tenantId, teachers: { some: { teacherId: user.teacherId! } } }
        : user.role === 'STUDENT'
          ? { tenantId, id: user.studentId! }
          : { tenantId };
    const teacherScope = user.role === 'TEACHER' ? { teacherId: user.teacherId! } : {};

    const students = await this.prisma.student.findMany({
      where: studentWhere,
      select: { id: true, user: { select: { fullName: true } } },
      orderBy: { user: { fullName: 'asc' } },
    });
    if (students.length === 0) return [];
    const ids = students.map((s) => s.id);

    const [attendance, results] = await Promise.all([
      this.prisma.sessionAttendee.findMany({
        where: {
          studentId: { in: ids },
          session: { tenantId, startAt: { gte: from, lt: to }, status: { notIn: ['CANCELED', 'MISSED'] }, ...teacherScope },
        },
        select: { studentId: true, attended: true, status: true, rating: true },
      }),
      this.prisma.examResult.findMany({
        where: { studentId: { in: ids }, exam: { tenantId, month: from, ...teacherScope } },
        select: { studentId: true, score: true, exam: { select: { totalMarks: true } } },
      }),
    ]);

    return students.map((s) => {
      const att = attendance.filter((a) => a.studentId === s.id);
      const res = results.filter((r) => r.studentId === s.id);
      const sessionsAttended = att.filter((a) => a.attended).length;
      const pct = res.map((r) => (Number(r.score) / r.exam.totalMarks) * 100);
      const ratings = att.flatMap((a) => (a.rating == null ? [] : [a.rating]));
      return {
        studentId: s.id,
        studentName: s.user.fullName,
        month,
        sessionsTotal: att.length,
        sessionsAttended,
        sessionsLate: att.filter((a) => a.status === 'LATE').length,
        attendanceRate: att.length ? sessionsAttended / att.length : 0,
        examsCount: res.length,
        averageScore: pct.length ? pct.reduce((a, b) => a + b, 0) / pct.length : null,
        averageRating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
      };
    });
  }
}
