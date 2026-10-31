import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import type { MessageKey } from '../../i18n/i18n.js';

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** A period of calendar days in the center's time zone, both days included, plus the usual narrowing. */
export class ReportQueryDto {
  @Matches(DAY, { message: 'reports.invalidDate' satisfies MessageKey })
  from: string;

  @Matches(DAY, { message: 'reports.invalidDate' satisfies MessageKey })
  to: string;

  @IsOptional()
  @IsUUID()
  teacherId?: string;

  @IsOptional()
  @IsUUID()
  courseId?: string;

  /** PDFs only: the document's language, when it should differ from the request's. */
  @IsOptional()
  @IsIn(['ar', 'en'])
  lang?: 'ar' | 'en';
}

export class StudentReportQueryDto extends ReportQueryDto {
  /** Admins only: add the session charges to the report. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  finance?: boolean;
}
