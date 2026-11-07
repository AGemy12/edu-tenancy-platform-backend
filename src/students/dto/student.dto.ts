import { ArrayUnique, IsArray, IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
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

  /** Admins: the teachers to link the student to (with `teacherId`, if both are sent). Ignored for teachers. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  teacherIds?: string[];
}

export class UpdateStudentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  fullName?: string;

  /** The sign-in email: changeable only while the account is this center's alone (see auth/member-account). */
  @IsOptional()
  @IsEmail()
  email?: string;

  /** A new password, under the same rule as the email; empty or omitted keeps the current one. */
  @IsOptional()
  @IsString()
  @IsStrongPassword()
  password?: string;

  /** Admins: the student's teachers, replacing the current links. Ignored for teachers. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  teacherIds?: string[];

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
