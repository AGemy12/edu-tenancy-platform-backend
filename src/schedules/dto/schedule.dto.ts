import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { SessionProvider } from '../../generated/prisma/enums.js';

export class ScheduleSlotDto {
  /** 0 = Sunday … 6 = Saturday. */
  @IsInt()
  @Min(0)
  @Max(6)
  weekday: number;

  /** "HH:mm" in the center's timezone. */
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  startTime: string;
}

/** What the session layout depends on. */
class SchedulePlanDto {
  /** Required for admins; ignored for teachers. */
  @IsOptional()
  @IsUUID()
  teacherId?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.25)
  @Max(200)
  monthlyHours: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.25)
  @Max(60)
  weeklyHours: number;

  /** First day of the period (YYYY-MM-DD, the center's calendar). */
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  startDate: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(14)
  @ValidateNested({ each: true })
  @Type(() => ScheduleSlotDto)
  slots: ScheduleSlotDto[];
}

/** Lays out the month without saving anything. */
export class PreviewScheduleDto extends SchedulePlanDto {
  /** When given, the student's own clashes are reported too. */
  @IsOptional()
  @IsUUID()
  studentId?: string;
}

export class CreateScheduleDto extends SchedulePlanDto {
  @IsUUID()
  studentId: string;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsOptional()
  @IsUUID()
  courseId?: string;

  @IsEnum(SessionProvider)
  provider: SessionProvider;

  /** Required when provider = MANUAL; every session uses it. */
  @IsOptional()
  @IsUrl()
  meetingUrl?: string;
}
