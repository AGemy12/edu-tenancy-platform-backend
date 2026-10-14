import { IsDateString, IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { SubscriptionStatus } from '../../generated/prisma/enums.js';

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
