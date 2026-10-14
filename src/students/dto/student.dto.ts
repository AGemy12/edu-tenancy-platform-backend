import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { IsStrongPassword } from '../../auth/password-policy.js';

export class CreateStudentDto {
  @IsString()
  @IsNotEmpty()
  fullName: string;

  @IsEmail()
  email: string;

  /** Optional: without one, the student picks a password from the welcome email. */
  @IsOptional()
  @IsString()
  @IsStrongPassword()
  password?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  grade?: string;

  @IsOptional()
  @IsString()
  parentPhone?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  /** Link the student to a teacher on creation. Teachers creating students are linked automatically. */
  @IsOptional()
  @IsUUID()
  teacherId?: string;
}

export class UpdateStudentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  fullName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  grade?: string;

  @IsOptional()
  @IsString()
  parentPhone?: string;

  @IsOptional()
  @IsString()
  notes?: string;

}

export class LinkTeacherDto {
  @IsUUID()
  teacherId: string;
}
