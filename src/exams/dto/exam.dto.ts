import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ExamStatus } from '../../generated/prisma/enums.js';

export class CreateExamDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsUUID()
  courseId: string;

  /** Any date inside the target month; normalized to the 1st. */
  @IsDateString()
  month: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  totalMarks?: number;
}

export class UpdateExamDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  month?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  totalMarks?: number;

  @IsOptional()
  @IsEnum(ExamStatus)
  status?: ExamStatus;
}

export class GradeDto {
  @IsUUID()
  studentId: string;

  @IsNumber()
  @Min(0)
  score: number;

  @IsOptional()
  @IsString()
  feedback?: string;
}

export class GradeManyDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => GradeDto)
  results: GradeDto[];
}
