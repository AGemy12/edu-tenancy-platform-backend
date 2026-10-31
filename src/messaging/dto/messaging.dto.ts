import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_GROUP_MEMBERS, MAX_GROUP_TITLE, MAX_MESSAGE_LENGTH } from '../messaging-rules.js';

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

export class InboxQueryDto {
  /** The archive instead of the inbox. */
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  archived?: boolean;
}

export class ContactsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;
}

export class StartDirectDto {
  @IsUUID()
  membershipId: string;
}

export class CreateGroupDto {
  /** Optional for a course group (defaults to the course's title). */
  @IsOptional()
  @IsString()
  @Length(1, MAX_GROUP_TITLE)
  title?: string;

  /** A course's class group: its teacher and every enrolled student, kept in step with enrollments. */
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_GROUP_MEMBERS)
  @IsUUID('all', { each: true })
  membershipIds?: string[];

  @IsOptional()
  @IsBoolean()
  adminsOnly?: boolean;
}

export class UpdateGroupDto {
  @IsOptional()
  @IsString()
  @Length(1, MAX_GROUP_TITLE)
  title?: string;

  @IsOptional()
  @IsBoolean()
  adminsOnly?: boolean;
}

export class AddMembersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_GROUP_MEMBERS)
  @IsUUID('all', { each: true })
  membershipIds: string[];
}

export class SetMemberRoleDto {
  @IsBoolean()
  isAdmin: boolean;
}

export class ConversationSettingsDto {
  @IsOptional()
  @IsBoolean()
  muted?: boolean;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class MessagesQueryDto {
  /** Messages older than this one (the oldest already shown). */
  @IsOptional()
  @IsUUID()
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}

export class SendMessageDto {
  @IsString()
  @Length(1, MAX_MESSAGE_LENGTH)
  body: string;

  /** Chosen by the sending device (a UUID or similar): a resent message is stored once. */
  @IsString()
  @Matches(/^[\w-]{8,64}$/)
  clientId: string;

  @IsOptional()
  @IsUUID()
  replyToId?: string;
}

export class EditMessageDto {
  @IsString()
  @Length(1, MAX_MESSAGE_LENGTH)
  body: string;
}
