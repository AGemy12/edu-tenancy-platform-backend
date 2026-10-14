import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { AttendanceStatus, SessionProvider } from '../../generated/prisma/enums.js';

export class CreateSessionDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Required for admins; ignored for teachers. */
  @IsOptional()
  @IsUUID()
  teacherId?: string;

  @IsOptional()
  @IsUUID()
  courseId?: string;

  /** Explicit attendees. If omitted and courseId is set, all enrolled students are added. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  studentIds?: string[];

  @IsEnum(SessionProvider)
  provider: SessionProvider;

  @IsDateString()
  startAt: string;

  @IsDateString()
  endAt: string;

  /** Required when provider = MANUAL; ignored otherwise. */
  @IsOptional()
  @IsUrl()
  meetingUrl?: string;
}

/** Status changes go through the start / complete / cancel actions, never a PATCH. */
export class UpdateSessionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

  @IsOptional()
  @IsUrl()
  meetingUrl?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class AttendanceDto {
  @IsUUID()
  studentId: string;

  @IsBoolean()
  attended: boolean;
}

export class EvaluationDto {
  @IsUUID()
  studentId: string;

  @IsEnum(AttendanceStatus)
  status: AttendanceStatus;

  /** 1–10; ignored for absent students. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  rating?: number;

  /** What to do before next time; empty means no homework. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  homework?: string;

  /** Where the lesson stopped. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  progress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

/** The teacher's evaluation of the session, one entry per student. */
export class EvaluateSessionDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => EvaluationDto)
  evaluations: EvaluationDto[];
}
