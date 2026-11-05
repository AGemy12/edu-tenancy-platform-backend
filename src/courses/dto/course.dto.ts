import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class CreateCourseDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  /** Required for admins; ignored for teachers (their own id is used). */
  @IsOptional()
  @IsUUID()
  teacherId?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  level?: string;

  /** Admins only: what a student pays per session of this course (null = the center's default price). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  sessionPrice?: number | null;
}

export class UpdateCourseDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  level?: string;

  /** Admins only: what a student pays per session of this course (null = the center's default price). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  sessionPrice?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class EnrollDto {
  @IsUUID()
  studentId: string;
}
