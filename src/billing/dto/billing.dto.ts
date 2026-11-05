import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { RateBasis, SessionProvider, SessionStatus } from '../../generated/prisma/enums.js';

/** `?status=LIVE,COMPLETED` or a repeated `?status=` both arrive as an array. */
const toList = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : (Array.isArray(value) ? value : String(value).split(',')).filter(Boolean);

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

export const BILLING_SORTS = ['date_desc', 'date_asc', 'amount_desc', 'amount_asc', 'duration_desc'] as const;
export type BillingSort = (typeof BILLING_SORTS)[number];

export const BILLING_GROUPS = ['teacher', 'student', 'course', 'month'] as const;
export type BillingGroup = (typeof BILLING_GROUPS)[number];

/** Filters shared by the session list and the summary. Role scoping is applied on top. */
export class BillingQueryDto {
  /** Sessions starting at or after this instant. */
  @IsISO8601()
  from: string;

  /** Sessions starting before this instant. */
  @IsISO8601()
  to: string;

  @IsOptional()
  @IsUUID()
  teacherId?: string;

  @IsOptional()
  @IsUUID()
  studentId?: string;

  @IsOptional()
  @IsUUID()
  courseId?: string;

  @IsOptional()
  @IsEnum(SessionProvider)
  provider?: SessionProvider;

  /** Defaults to the charged statuses (LIVE, COMPLETED). */
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsEnum(SessionStatus, { each: true })
  status?: SessionStatus[];

  /** Keep only students who joined, or only those who didn't. */
  @IsOptional()
  @IsIn(['attended', 'absent'])
  attendance?: 'attended' | 'absent';

  /** Whether the teacher's entry was recorded (a real start time) or only assumed. */
  @IsOptional()
  @IsIn(['confirmed', 'unconfirmed'])
  entry?: 'confirmed' | 'unconfirmed';

  /** Only sessions with a student or teacher price missing from the rate card. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  missingRate?: boolean;

  /** Matches the session title, course, teacher or a student's name. */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class BillingSessionsQueryDto extends BillingQueryDto {
  @IsOptional()
  @IsIn(BILLING_SORTS)
  sort?: BillingSort;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class BillingSummaryQueryDto extends BillingQueryDto {
  @IsIn(BILLING_GROUPS)
  groupBy: BillingGroup;
}

/** Super admin: the platform's earnings over a period. */
export class PlatformBillingQueryDto {
  @IsISO8601()
  from: string;

  @IsISO8601()
  to: string;
}

/** A session price in the center's currency, from now on. null removes it. */
export class SetPriceDto {
  @ValidateIf((o) => o.amount !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  amount: number | null;
}

/** One student's price in one course. null returns them to the course's price. */
export class SetSpecialPriceDto extends SetPriceDto {
  @IsUUID()
  courseId: string;

  @IsUUID()
  studentId: string;
}

/** A teacher's pay per session: a fixed amount (PER_SESSION) or a % of the session's fees. null removes it. */
export class SetTeacherPayDto {
  @IsOptional()
  @IsEnum(RateBasis)
  basis?: RateBasis;

  @ValidateIf((o) => o.amount !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  amount: number | null;
}
