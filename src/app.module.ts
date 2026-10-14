import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { MailModule } from './mail/mail.module.js';
import { AuthModule } from './auth/auth.module.js';
import { TenantsModule } from './tenants/tenants.module.js';
import { TeachersModule } from './teachers/teachers.module.js';
import { StudentsModule } from './students/students.module.js';
import { CoursesModule } from './courses/courses.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { SchedulesModule } from './schedules/schedules.module.js';
import { ExamsModule } from './exams/exams.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { BillingModule } from './billing/billing.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { LibraryModule } from './library/library.module.js';
import { PlansModule } from './plans/plans.module.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import { AccountStatusGuard } from './auth/account-status.js';
import { SubscriptionGuard } from './tenants/subscription.guard.js';
import { validateEnv } from './config/env.js';
import { I18nExceptionFilter } from './i18n/i18n-exception.filter.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Per-IP request budget; auth routes set tighter limits with @Throttle.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 600 }]),
    PrismaModule,
    MailModule,
    AuthModule,
    TenantsModule,
    TeachersModule,
    StudentsModule,
    CoursesModule,
    SessionsModule,
    SchedulesModule,
    ExamsModule,
    ReportsModule,
    BillingModule,
    IntegrationsModule,
    PlansModule,
    LibraryModule,
  ],
  controllers: [AppController],
  providers: [
    // Rate limit first, then: every route requires a valid JWT unless marked @Public(); then roles are
    // checked; then centers whose subscription has lapsed are kept to reads.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: AccountStatusGuard },
    { provide: APP_GUARD, useClass: SubscriptionGuard },
    // Translates error messages to the request language (Accept-Language).
    { provide: APP_FILTER, useClass: I18nExceptionFilter },
  ],
})
export class AppModule {}
