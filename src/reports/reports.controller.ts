import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ReportsService } from './reports.service.js';
import { ReportPdfService, type PdfFile } from './pdf/report-pdf.service.js';
import { ReportQueryDto, StudentReportQueryDto } from './dto/report.dto.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Lang } from '../i18n/lang.decorator.js';
import type { Locale } from '../i18n/locale.js';

const STAFF = ['TENANT_ADMIN', 'TEACHER'] as const;

/**
 * Reports over a period of days in the center's time zone. Every report is JSON for the screen
 * and, at `…/pdf`, the same figures as a branded PDF in the request's language (or `?lang=`).
 * Admins see the center, teachers their own sessions and students, students only themselves.
 */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly pdf: ReportPdfService,
  ) {}

  @Get('options')
  @Roles(...STAFF, 'STUDENT')
  options(@CurrentUser() user: JwtUser) {
    return this.reports.options(user);
  }

  @Get('center')
  @Roles('TENANT_ADMIN')
  center(@CurrentUser() user: JwtUser, @Query() q: ReportQueryDto) {
    return this.reports.center(user, q);
  }

  @Get('center/pdf')
  @Roles('TENANT_ADMIN')
  @ApiProduces('application/pdf')
  async centerPdf(@CurrentUser() user: JwtUser, @Query() q: ReportQueryDto, @Lang() lang: Locale, @Res() res: Response) {
    send(res, await this.toPdf(user, await this.reports.center(user, q), q.lang ?? lang));
  }

  @Get('students')
  @Roles(...STAFF)
  students(@CurrentUser() user: JwtUser, @Query() q: ReportQueryDto) {
    return this.reports.students(user, q);
  }

  /** Declared before `students/:id`. */
  @Get('students/pdf')
  @Roles(...STAFF)
  @ApiProduces('application/pdf')
  async studentsPdf(@CurrentUser() user: JwtUser, @Query() q: ReportQueryDto, @Lang() lang: Locale, @Res() res: Response) {
    send(res, await this.toPdf(user, await this.reports.students(user, q), q.lang ?? lang));
  }

  /** A student's own report (declared before `students/:id`). */
  @Get('students/me')
  @Roles('STUDENT')
  me(@CurrentUser() user: JwtUser, @Query() q: StudentReportQueryDto) {
    return this.reports.student(user, user.studentId!, q);
  }

  @Get('students/me/pdf')
  @Roles('STUDENT')
  @ApiProduces('application/pdf')
  async mePdf(@CurrentUser() user: JwtUser, @Query() q: StudentReportQueryDto, @Lang() lang: Locale, @Res() res: Response) {
    send(res, await this.toPdf(user, await this.reports.student(user, user.studentId!, q), q.lang ?? lang));
  }

  @Get('students/:id')
  @Roles(...STAFF, 'STUDENT')
  student(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: StudentReportQueryDto) {
    return this.reports.student(user, id, q);
  }

  @Get('students/:id/pdf')
  @Roles(...STAFF, 'STUDENT')
  @ApiProduces('application/pdf')
  async studentPdf(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: StudentReportQueryDto,
    @Lang() lang: Locale,
    @Res() res: Response,
  ) {
    send(res, await this.toPdf(user, await this.reports.student(user, id, q), q.lang ?? lang));
  }

  @Get('alerts')
  @Roles(...STAFF)
  alerts(@CurrentUser() user: JwtUser, @Query() q: ReportQueryDto) {
    return this.reports.alerts(user, q);
  }

  @Get('register')
  @Roles(...STAFF)
  register(@CurrentUser() user: JwtUser, @Query() q: ReportQueryDto) {
    return this.reports.register(user, q);
  }

  @Get('register/pdf')
  @Roles(...STAFF)
  @ApiProduces('application/pdf')
  async registerPdf(@CurrentUser() user: JwtUser, @Query() q: ReportQueryDto, @Lang() lang: Locale, @Res() res: Response) {
    send(res, await this.toPdf(user, await this.reports.register(user, q), q.lang ?? lang));
  }

  @Get('teachers')
  @Roles(...STAFF)
  teachers(@CurrentUser() user: JwtUser, @Query() q: ReportQueryDto) {
    return this.reports.teachers(user, q);
  }

  @Get('teachers/:id')
  @Roles(...STAFF)
  teacher(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: ReportQueryDto) {
    return this.reports.teacher(user, id, q);
  }

  @Get('teachers/:id/pdf')
  @Roles(...STAFF)
  @ApiProduces('application/pdf')
  async teacherPdf(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: ReportQueryDto, @Lang() lang: Locale, @Res() res: Response) {
    send(res, await this.toPdf(user, await this.reports.teacher(user, id, q), q.lang ?? lang));
  }

  @Get('courses')
  @Roles(...STAFF)
  courses(@CurrentUser() user: JwtUser, @Query() q: ReportQueryDto) {
    return this.reports.courses(user, q);
  }

  @Get('courses/:id')
  @Roles(...STAFF)
  course(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: ReportQueryDto) {
    return this.reports.course(user, id, q);
  }

  @Get('courses/:id/pdf')
  @Roles(...STAFF)
  @ApiProduces('application/pdf')
  async coursePdf(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: ReportQueryDto, @Lang() lang: Locale, @Res() res: Response) {
    send(res, await this.toPdf(user, await this.reports.course(user, id, q), q.lang ?? lang));
  }

  private async toPdf(user: JwtUser, report: Parameters<ReportPdfService['render']>[0], lang: Locale) {
    return this.pdf.render(report, lang, await this.reports.logoKey(user.tenantId!));
  }
}

function send(res: Response, file: PdfFile) {
  const fallback = file.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  res
    .set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      'Content-Length': String(file.data.length),
      'Cache-Control': 'private, no-store',
    })
    .end(file.data);
}
