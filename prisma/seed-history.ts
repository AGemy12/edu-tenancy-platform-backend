import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type { AttendanceStatus, SessionStatus } from '../src/generated/prisma/enums.js';
import { zonedTime } from '../src/schedules/schedule-plan.js';

/**
 * Optional demo history for the demo center (run `npm run db:seed` first): a second teacher, more
 * students, three courses, three months of sessions with evaluations, and graded exams, so the
 * reports have something to show. Runs once; later runs do nothing.
 */
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

const MARK = 'demo-history';
const FROM = '2026-08-02';
const TO = '2026-11-15';

/** Deterministic pseudo-random numbers, so every run builds the same history. */
let state = 20261021;
const rand = () => {
  state = (state * 1664525 + 1013904223) % 2 ** 32;
  return state / 2 ** 32;
};
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const PROGRESS = ['الوحدة الأولى: الدوال', 'الوحدة الثانية: النهايات', 'تمارين صفحة 42', 'مراجعة الاشتقاق', 'الفصل الثالث: التكامل', 'حل امتحان سابق'];
const HOMEWORK = ['حل تمارين صفحة 45 من 1 إلى 10', 'مراجعة القوانين وحفظها', 'حل الورقة المرفقة في المكتبة', 'تلخيص الدرس في صفحة واحدة'];
const COMMENTS = ['مشاركة ممتازة، استمر', 'يحتاج إلى تركيز أكثر في الحل', 'تحسّن واضح عن الأسبوع الماضي', 'أداء جيد لكن ينقصه التنظيم', 'سؤال ذكي اليوم، أحسنت'];

async function main() {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'demo-center' } });
  if (await prisma.session.count({ where: { tenantId: tenant.id, notes: MARK } })) {
    console.log('Demo history already there.');
    return;
  }
  const password = await bcrypt.hash('Password123!', 10);
  const tz = tenant.timezone;

  async function member(email: string, fullName: string, role: 'TEACHER' | 'STUDENT') {
    const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email, passwordHash: password, fullName } });
    const membership = await prisma.membership.upsert({
      where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
      update: {},
      create: { userId: user.id, tenantId: tenant.id, role, createdAt: new Date('2026-07-25T09:00:00Z') },
    });
    return { user, membership };
  }

  const teacher1 = await prisma.teacher.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email: 'teacher@demo.local' } } });
  const t2 = await member('teacher2@demo.local', 'أ. منى حسن', 'TEACHER');
  const teacher2 = await prisma.teacher.upsert({
    where: { membershipId: t2.membership.id },
    update: {},
    create: { tenantId: tenant.id, userId: t2.user.id, membershipId: t2.membership.id, subjects: ['لغة إنجليزية'] },
  });

  // Each student's habits: how often they come, how often late, and their level (ratings and scores).
  const profiles = [
    { email: 'student@demo.local', name: 'سارة علي', grade: 'الصف الثالث الثانوي', come: 0.93, late: 0.08, level: 0.88 },
    { email: 'student2@demo.local', name: 'يوسف أحمد', grade: 'الصف الثالث الثانوي', come: 0.86, late: 0.15, level: 0.74 },
    { email: 'student3@demo.local', name: 'مريم خالد', grade: 'الصف الثاني الثانوي', come: 0.97, late: 0.03, level: 0.94 },
    { email: 'student4@demo.local', name: 'عمر حسن', grade: 'الصف الثالث الثانوي', come: 0.58, late: 0.25, level: 0.46, slump: true },
    { email: 'student5@demo.local', name: 'ليلى محمود', grade: 'الصف الثاني الثانوي', come: 0.82, late: 0.1, level: 0.68, excused: true },
    { email: 'student6@demo.local', name: 'كريم عادل', grade: 'الصف الثالث الثانوي', come: 0.75, late: 0.3, level: 0.55 },
    { email: 'student7@demo.local', name: 'نور الهدى سامي', grade: 'الصف الثاني الثانوي', come: 0.9, late: 0.05, level: 0.81 },
  ];
  const students: ((typeof profiles)[number] & { id: string; slump?: boolean; excused?: boolean })[] = [];
  for (const [i, p] of profiles.entries()) {
    const m = await member(p.email, p.name, 'STUDENT');
    const s = await prisma.student.upsert({
      where: { membershipId: m.membership.id },
      update: {},
      create: { tenantId: tenant.id, userId: m.user.id, membershipId: m.membership.id, grade: p.grade, parentPhone: `0100000000${i}`, createdAt: new Date('2026-07-25T09:00:00Z') },
    });
    students.push({ ...p, id: s.id });
  }

  const course = async (teacherId: string, title: string, subject: string) =>
    (await prisma.course.findFirst({ where: { tenantId: tenant.id, title } })) ??
    prisma.course.create({ data: { tenantId: tenant.id, teacherId, title, subject, level: 'ثانوي' } });
  const math = await course(teacher1.id, 'رياضيات - الفصل الأول', 'رياضيات');
  const physics = await course(teacher1.id, 'فيزياء - مراجعة نهائية', 'فيزياء');
  const english = await course(teacher2.id, 'English Conversation', 'English');

  const groups = [
    { course: math, teacherId: teacher1.id, members: [0, 1, 2, 3, 4], days: [0, 2], time: '17:00', minutes: 90, title: 'حصة الرياضيات', marks: 100 },
    { course: physics, teacherId: teacher1.id, members: [0, 5, 6, 3], days: [1], time: '18:30', minutes: 60, title: 'مراجعة الفيزياء', marks: 50 },
    { course: english, teacherId: teacher2.id, members: [0, 2, 4, 5, 6], days: [3], time: '16:00', minutes: 60, title: 'Speaking practice', marks: 20 },
  ];

  for (const g of groups) {
    for (const i of g.members) {
      const studentId = students[i].id;
      await prisma.enrollment.upsert({
        where: { courseId_studentId: { courseId: g.course.id, studentId } },
        update: {},
        create: { tenantId: tenant.id, courseId: g.course.id, studentId, enrolledAt: new Date('2026-08-01T09:00:00Z') },
      });
      await prisma.teacherStudent.upsert({
        where: { teacherId_studentId: { teacherId: g.teacherId, studentId } },
        update: {},
        create: { teacherId: g.teacherId, studentId },
      });
    }
  }

  const now = new Date();
  let sessions = 0;
  for (let day = FROM; day <= TO; day = nextDay(day)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    for (const g of groups) {
      if (!g.days.includes(weekday)) continue;
      const startAt = zonedTime(day, g.time, tz);
      const endAt = new Date(startAt.getTime() + g.minutes * 60_000);
      const past = endAt < now;
      // A few emergencies, one session the teacher never opened, and the last week still waiting for evaluations.
      const roll = rand();
      const status: SessionStatus = !past ? 'SCHEDULED' : roll < 0.04 ? 'CANCELED' : roll < 0.06 ? 'MISSED' : 'COMPLETED';
      const recent = now.getTime() - startAt.getTime() < 6 * 24 * 3600_000;
      const evaluate = status === 'COMPLETED' && !(recent && rand() < 0.7);
      const delay = status === 'COMPLETED' ? (rand() < 0.75 ? Math.floor(rand() * 5) : 6 + Math.floor(rand() * 14)) : 0;

      await prisma.session.create({
        data: {
          tenantId: tenant.id,
          teacherId: g.teacherId,
          courseId: g.course.id,
          title: g.title,
          provider: 'MANUAL',
          status,
          startAt,
          endAt,
          notes: MARK,
          startedAt: status === 'COMPLETED' ? new Date(startAt.getTime() + delay * 60_000) : null,
          endedAt: status === 'COMPLETED' ? new Date(endAt.getTime() + Math.floor(rand() * 10) * 60_000) : null,
          attendees: {
            create: g.members.map((i) => {
              const p = students[i];
              if (status !== 'COMPLETED') return { studentId: p.id };
              // Omar drops off in October.
              const come = p.slump && day >= '2026-10-01' ? 0.25 : p.come;
              const came = rand() < come;
              const late = came && rand() < p.late;
              const attStatus: AttendanceStatus = came ? (late ? 'LATE' : 'PRESENT') : p.excused && rand() < 0.6 ? 'EXCUSED' : 'ABSENT';
              const joinedAt = came ? new Date(startAt.getTime() + (late ? 10 + Math.floor(rand() * 15) : Math.floor(rand() * 4)) * 60_000) : null;
              if (!evaluate) return { studentId: p.id, attended: came, joinedAt };
              const rating = came ? Math.max(3, Math.min(10, Math.round(p.level * 10 + (rand() - 0.5) * 3))) : null;
              return {
                studentId: p.id,
                attended: came,
                joinedAt,
                status: attStatus,
                rating,
                progress: pick(PROGRESS),
                homework: rand() < 0.6 ? pick(HOMEWORK) : null,
                comment: came && rand() < 0.35 ? pick(COMMENTS) : null,
                evaluatedAt: endAt,
              };
            }),
          },
        },
      });
      sessions++;
    }
  }

  // Graded exams for September and October, and an October draft that reports must ignore.
  const exams = [
    { g: groups[0], title: 'اختبار شهر سبتمبر', month: '2026-09-01', status: 'CLOSED' as const },
    { g: groups[0], title: 'اختبار شهر أكتوبر', month: '2026-10-01', status: 'PUBLISHED' as const },
    { g: groups[1], title: 'اختبار الفيزياء الشهري', month: '2026-10-01', status: 'PUBLISHED' as const },
    { g: groups[2], title: 'Vocabulary quiz', month: '2026-09-01', status: 'CLOSED' as const },
    { g: groups[2], title: 'Listening test', month: '2026-10-01', status: 'PUBLISHED' as const },
    { g: groups[0], title: 'مسودة اختبار نهائي', month: '2026-10-01', status: 'DRAFT' as const },
  ];
  for (const e of exams) {
    await prisma.exam.create({
      data: {
        tenantId: tenant.id,
        courseId: e.g.course.id,
        teacherId: e.g.teacherId,
        title: e.title,
        month: new Date(`${e.month}T00:00:00Z`),
        totalMarks: e.g.marks,
        status: e.status,
        results:
          e.status === 'DRAFT'
            ? undefined
            : {
                create: e.g.members.map((i) => {
                  const p = students[i];
                  const level = p.slump && e.month === '2026-10-01' ? p.level - 0.12 : p.level;
                  const pct = Math.max(0.2, Math.min(1, level + (rand() - 0.5) * 0.18));
                  return {
                    studentId: p.id,
                    score: Math.round(pct * e.g.marks * 2) / 2,
                    feedback: pct > 0.85 ? 'ممتاز' : pct < 0.5 ? 'يحتاج إلى مراجعة الأساسيات' : null,
                    gradedAt: new Date(`${e.month.slice(0, 8)}26T12:00:00Z`),
                  };
                }),
              },
      },
    });
  }

  console.log(`Demo history added: ${sessions} sessions, ${exams.length} exams, ${students.length} students.`);
  console.log('  Second teacher: teacher2@demo.local / Password123!');
}

function nextDay(day: string) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
