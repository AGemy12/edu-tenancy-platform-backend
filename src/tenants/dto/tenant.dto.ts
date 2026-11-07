import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { SubscriptionStatus } from '../../generated/prisma/enums.js';
import type { MessageKey } from '../../i18n/i18n.js';

export class SetTenantStatusDto {
  @IsIn(['ACTIVE', 'SUSPENDED'])
  status: 'ACTIVE' | 'SUSPENDED';
}

/** The center's own settings (admin). Timezone and currency are checked against Intl in the service. */
export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  /** IANA zone, e.g. "Africa/Cairo": monthly schedules lay out sessions in it. */
  @IsOptional()
  @IsString()
  timezone?: string;

  /** ISO 4217 code, e.g. "EGP": session billing amounts are in it. */
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  /** Whether a student absent without an excuse still pays for the session. */
  @IsOptional()
  @IsBoolean()
  chargeAbsent?: boolean;
}

/** Super admin: change a center's package, status or period (manual renewals until payments exist). */
export class UpdateSubscriptionDto {
  @IsOptional()
  @IsUUID()
  planId?: string;

  @IsOptional()
  @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus;

  /** A date, or null for no end (granted for good). Omitted = unchanged. */
  @IsOptional()
  @IsDateString()
  currentPeriodEnd?: string | null;
}

/** Super admin: the platform's fee on one center's sessions, overriding its package's. null = the package's; 0 = none. */
export class SetPlatformFeeDto {
  @ValidateIf((o) => o.percent !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  percent: number | null;
}

/**
 * Super admin: the same commission on many centers at once. With `tenantIds`, only those;
 * without, every center except the ones in `except`.
 */
export class BulkPlatformFeeDto extends SetPlatformFeeDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  tenantIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  except?: string[];
}

/**
 * Super admin: a new center set up by the platform, with its owner and package. The owner may be
 * an existing account (the center is added to it) or a new one that chooses a password by email.
 */
export class CreateTenantByAdminDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @IsString()
  @Matches(/^[a-z0-9-]{3,40}$/, { message: 'validation.slugFormat' satisfies MessageKey })
  slug: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  ownerName: string;

  @IsEmail()
  ownerEmail: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  ownerPhone?: string;

  @IsUUID()
  planId: string;

  @IsIn(['TRIALING', 'ACTIVE'])
  status: 'TRIALING' | 'ACTIVE';

  /** A date, or null (or omitted) for no end. */
  @IsOptional()
  @IsDateString()
  currentPeriodEnd?: string | null;
}
