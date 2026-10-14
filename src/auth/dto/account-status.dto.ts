import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { AccountStatus } from '../../generated/prisma/enums.js';

/** Suspend, block or reactivate a member, optionally saying why (the member sees the reason). */
export class SetAccountStatusDto {
  @IsEnum(AccountStatus)
  status: AccountStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
