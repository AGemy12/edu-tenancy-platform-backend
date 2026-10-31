import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { AnnouncementAudience, NotificationCategory } from '../../generated/prisma/enums.js';

export class ListNotificationsQueryDto {
  /** The last id of the previous page. */
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  take?: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  unread?: boolean;

  @IsOptional()
  @IsEnum(NotificationCategory)
  category?: NotificationCategory;
}

export class MarkReadDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids: string[];
}

export class ReadAllDto {
  @IsOptional()
  @IsEnum(NotificationCategory)
  category?: NotificationCategory;
}

export class PreferenceDto {
  @IsEnum(NotificationCategory)
  category: NotificationCategory;

  @IsBoolean()
  inApp: boolean;

  @IsBoolean()
  email: boolean;
}

export class SetPreferencesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PreferenceDto)
  items: PreferenceDto[];
}

export class CreateAnnouncementDto {
  @IsString()
  @Length(3, 120)
  title: string;

  @IsString()
  @Length(1, 2000)
  body: string;

  @IsEnum(AnnouncementAudience)
  audience: AnnouncementAudience;

  /** Platform only: the centers to address; every active center when left out. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  tenantIds?: string[];
}
