import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PickType } from '@nestjs/swagger';
import type { MessageKey } from '../../i18n/i18n.js';
import { IsStrongPassword } from '../password-policy.js';

// Validation messages are dictionary keys; I18nExceptionFilter translates them.
const SLUG_FORMAT: MessageKey = 'validation.slugFormat';

export class RegisterTenantDto {
  @IsString()
  @IsNotEmpty()
  tenantName: string;

  @IsString()
  @Matches(/^[a-z0-9-]{3,40}$/, { message: SLUG_FORMAT })
  tenantSlug: string;

  @IsString()
  @IsNotEmpty()
  fullName: string;

  @IsEmail()
  email: string;

  @IsString()
  @IsStrongPassword()
  password: string;
}

/** A signed-in user's new center: no account fields, they already have one. */
export class CreateTenantDto extends PickType(RegisterTenantDto, ['tenantName', 'tenantSlug'] as const) {
  /** The caller's own refresh token, retired as the session moves into the new center. */
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

/** Move the session to another center; `membershipId: null` is the platform console (operators only). */
export class SwitchMembershipDto {
  @IsOptional()
  @IsString()
  membershipId?: string | null;

  /** The caller's own refresh token, retired in favour of the new pair. */
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  /** Keep the session for 30 days (sliding) instead of one day. */
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email: string;
}

/** The signed-in user's own details. Changing the email needs the current password. */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string | null;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  currentPassword?: string;
}

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @IsString()
  @IsStrongPassword()
  newPassword: string;

  /** The caller's own refresh token: that session stays signed in, every other one is revoked. */
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsString()
  @IsStrongPassword()
  password: string;
}
