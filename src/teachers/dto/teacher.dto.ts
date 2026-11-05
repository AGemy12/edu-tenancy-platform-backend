import { IsArray, IsEmail, IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { RateBasis } from '../../generated/prisma/enums.js';
import { IsStrongPassword } from '../../auth/password-policy.js';
import type { HostedProvider } from '../../integrations/meeting-accounts.js';

export class CreateTeacherDto {
  @IsString()
  @IsNotEmpty()
  fullName: string;

  @IsEmail()
  email: string;

  /** Optional: without one, the teacher picks a password from the welcome email. */
  @IsOptional()
  @IsString()
  @IsStrongPassword()
  password?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subjects?: string[];

  /** Admins: what the center pays the teacher per session — a fixed amount, or a % of what its students pay. */
  @IsOptional()
  @IsEnum(RateBasis)
  payBasis?: RateBasis;

  /** The amount (or percentage); null removes the pay. Omitted = unchanged. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  payAmount?: number | null;
}

export class UpdateTeacherDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  fullName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subjects?: string[];

  /** Admins: what the center pays the teacher per session — a fixed amount, or a % of what its students pay. */
  @IsOptional()
  @IsEnum(RateBasis)
  payBasis?: RateBasis;

  /** The amount (or percentage); null removes the pay. Omitted = unchanged. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  payAmount?: number | null;
}

export class MeetingReminderDto {
  @IsIn(['ZOOM', 'GOOGLE_MEET'])
  provider: HostedProvider;
}
