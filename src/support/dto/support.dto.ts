import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { ACCESS_HOURS, SESSION_MINUTES } from '../support-rules.js';

/** Ask a center to let support in as one of its members; without `membershipId`, as its first active admin. */
export class RequestSupportDto {
  @IsUUID()
  tenantId: string;

  @IsOptional()
  @IsUUID()
  membershipId?: string;

  /** Why support needs in: shown to the center's admin, and kept with the request. */
  @IsString()
  @Length(5, 300)
  reason: string;

  /** How long each support session lasts. */
  @IsOptional()
  @IsInt()
  @Min(SESSION_MINUTES.min)
  @Max(SESSION_MINUTES.max)
  minutes?: number;
}

/** Enter a center under a request its admin approved. */
export class StartSupportDto {
  @IsUUID()
  requestId: string;
}

/** The center's admin lets support in for this many hours. */
export class ApproveSupportDto {
  @Type(() => Number)
  @IsIn([...ACCESS_HOURS])
  hours: number;
}

export class ListSupportQueryDto {
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  /** Only sessions still open. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}
