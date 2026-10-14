import { OmitType, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Length, Matches, MaxLength, Min } from 'class-validator';
import type { MessageKey } from '../../i18n/i18n.js';

const CODE_FORMAT: MessageKey = 'plans.codeFormat';

/** Super admin: a package in the catalog. Limits are what `PlansService.forTenant` enforces. */
export class CreatePlanDto {
  /** Stable id used in config and links (e.g. BASIC); upper-case letters, digits and underscores. */
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,19}$/, { message: CODE_FORMAT })
  code: string;

  @IsString()
  @Length(1, 60)
  nameAr: string;

  @IsString()
  @Length(1, 60)
  nameEn: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  descriptionAr?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  descriptionEn?: string | null;

  /** Monthly price; null or 0 = free. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  priceMonthly?: number | null;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsInt()
  @Min(0)
  maxTeachers: number;

  @IsInt()
  @Min(0)
  maxStudents: number;

  @IsInt()
  @Min(0)
  storagePerTeacherMb: number;

  @IsInt()
  @Min(0)
  sharedStorageMb: number;

  @IsInt()
  @Min(1)
  maxFileMb: number;

  /** Listed on the public upgrade screen; hidden packages are granted by the platform only. */
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  /** Retired packages keep their existing subscribers but can't be chosen for new ones. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/** The code is the package's identity and stays. */
export class UpdatePlanDto extends PartialType(OmitType(CreatePlanDto, ['code'] as const)) {}
