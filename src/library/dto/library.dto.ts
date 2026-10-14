import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { FileCategory, FileKind, LibraryScope } from '../../generated/prisma/enums.js';

export const FOLDER_COLORS = ['teal', 'coral', 'amber', 'sky', 'violet', 'rose', 'slate'] as const;

const UUID_OR_ROOT = /^(root|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** ?scope=PERSONAL (default) | SHARED */
export class ScopeQuery {
  @IsOptional()
  @IsEnum(LibraryScope)
  scope?: LibraryScope;
}

export class CreateFolderDto {
  @IsOptional()
  @IsEnum(LibraryScope)
  scope?: LibraryScope;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsIn(FOLDER_COLORS)
  color?: string;
}

export class UpdateFolderDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @IsOptional()
  @IsIn(FOLDER_COLORS)
  color?: string;

  /** Move: a folder id, or null for the library root. */
  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}

export class ListFilesQuery {
  @IsOptional()
  @IsEnum(LibraryScope)
  scope?: LibraryScope;

  /** A folder id, "root" for files outside any folder, or omitted for the whole library. */
  @IsOptional()
  @Matches(UUID_OR_ROOT)
  folderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsEnum(FileKind)
  kind?: FileKind;

  @IsOptional()
  @IsEnum(FileCategory)
  category?: FileCategory;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  starred?: boolean;

  @IsOptional()
  @IsIn(['createdAt', 'name', 'size'])
  sort?: 'createdAt' | 'name' | 'size';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

/** Multipart fields sent with each uploaded file. */
export class UploadFileDto {
  @IsOptional()
  @IsEnum(LibraryScope)
  scope?: LibraryScope;

  @IsOptional()
  @IsUUID()
  folderId?: string;

  @IsOptional()
  @IsEnum(FileCategory)
  category?: FileCategory;
}

export class UpdateFileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @IsOptional()
  @IsEnum(FileCategory)
  category?: FileCategory;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  starred?: boolean;

  /** Move: a folder id, or null for the library root. */
  @IsOptional()
  @IsUUID()
  folderId?: string | null;
}

export class FileIdsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids: string[];
}

export class MoveFilesDto extends FileIdsDto {
  /** Target folder id, or null for the library root. */
  @IsOptional()
  @IsUUID()
  folderId?: string | null;
}

export class SendFilesDto extends FileIdsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  studentIds: string[];
}

/** Copies center-library files into the caller's personal library (no storage charged). */
export class ImportFilesDto extends FileIdsDto {
  /** Target personal folder, or null/omitted for the library root. */
  @IsOptional()
  @IsUUID()
  folderId?: string | null;
}

/* ───────── Admin (storage monitor) ───────── */

export class UpdateMemberDto {
  /** Base allocation in MB; null resets to the package default. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  storageQuotaMb?: number | null;

  @IsOptional()
  @IsBoolean()
  canManageShared?: boolean;
}

export class ListBlobsQuery {
  @IsOptional()
  @IsUUID()
  userId?: string;

  /** true = only center-library files. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  shared?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
