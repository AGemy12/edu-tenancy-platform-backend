import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type { Role } from '../src/generated/prisma/enums.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  const password = await bcrypt.hash('Password123!', 10);
  const periodEnd = new Date();
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  // Platform super admin (no center)
  await prisma.user.upsert({
    where: { email: 'admin@platform.local' },
    update: { isPlatformAdmin: true },
    create: { email: 'admin@platform.local', passwordHash: password, fullName: 'Platform Admin', isPlatformAdmin: true },
  });

  // Demo tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo-center' },
    update: {},
    create: {
      name: 'مركز النور التعليمي',
      slug: 'demo-center',
      subscription: { create: { plan: { connect: { code: 'PRO' } }, status: 'ACTIVE', currentPeriodEnd: periodEnd } },
    },
  });

  /** A sign-in plus its membership in the demo center. */
  async function member(email: string, fullName: string, role: Role) {
    const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email, passwordHash: password, fullName } });
    const membership = await prisma.membership.upsert({
      where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
      update: {},
      create: { userId: user.id, tenantId: tenant.id, role },
    });
    await prisma.user.update({ where: { id: user.id }, data: { lastMembershipId: user.lastMembershipId ?? membership.id } });
    return { user, membership };
  }

  await member('owner@demo.local', 'أحمد المدير', 'TENANT_ADMIN');

  const teacherMember = await member('teacher@demo.local', 'أ. محمد سعيد', 'TEACHER');
  const teacher = await prisma.teacher.upsert({
    where: { membershipId: teacherMember.membership.id },
    update: {},
    create: { tenantId: tenant.id, userId: teacherMember.user.id, membershipId: teacherMember.membership.id, subjects: ['رياضيات', 'فيزياء'] },
  });

  const studentMember = await member('student@demo.local', 'سارة علي', 'STUDENT');
  const student = await prisma.student.upsert({
    where: { membershipId: studentMember.membership.id },
    update: {},
    create: {
      tenantId: tenant.id,
      userId: studentMember.user.id,
      membershipId: studentMember.membership.id,
      grade: 'الصف الثالث الثانوي',
      parentPhone: '01000000000',
    },
  });

  await prisma.teacherStudent.upsert({
    where: { teacherId_studentId: { teacherId: teacher.id, studentId: student.id } },
    update: {},
    create: { teacherId: teacher.id, studentId: student.id },
  });

  const course =
    (await prisma.course.findFirst({ where: { tenantId: tenant.id, title: 'رياضيات - الفصل الأول' } })) ??
    (await prisma.course.create({
      data: { tenantId: tenant.id, teacherId: teacher.id, title: 'رياضيات - الفصل الأول', subject: 'رياضيات', level: 'ثانوي', price: 500 },
    }));

  await prisma.enrollment.upsert({
    where: { courseId_studentId: { courseId: course.id, studentId: student.id } },
    update: {},
    create: { tenantId: tenant.id, courseId: course.id, studentId: student.id },
  });

  // Demo rate card: students pay 150/h with this teacher, who keeps 60% of what they pay.
  const hasRates = await prisma.billingRate.count({ where: { tenantId: tenant.id } });
  if (!hasRates) {
    const effectiveFrom = new Date(Date.UTC(2026, 0, 1));
    await prisma.billingRate.createMany({
      data: [
        { tenantId: tenant.id, kind: 'STUDENT_FEE', teacherId: teacher.id, amount: 150, effectiveFrom },
        { tenantId: tenant.id, kind: 'TEACHER_PAY', basis: 'PERCENT', teacherId: teacher.id, amount: 60, effectiveFrom },
      ],
    });
  }

  console.log('Seed complete.');
  console.log('  Tenant admin : owner@demo.local / Password123!');
  console.log('  Teacher      : teacher@demo.local / Password123!');
  console.log('  Student      : student@demo.local / Password123!');
  console.log('  Super admin  : admin@platform.local / Password123!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
