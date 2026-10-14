import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { LibraryService, type UploadedTempFile } from './library.service.js';
import {
  CreateFolderDto,
  FileIdsDto,
  ImportFilesDto,
  ListFilesQuery,
  ScopeQuery,
  MoveFilesDto,
  SendFilesDto,
  UpdateFileDto,
  UpdateFolderDto,
  UploadFileDto,
} from './dto/library.dto.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { msg, translate } from '../i18n/i18n.js';
import { Lang } from '../i18n/lang.decorator.js';
import type { Locale } from '../i18n/locale.js';

const OWNERS = ['TENANT_ADMIN', 'TEACHER'] as const;

@ApiTags('library')
@ApiBearerAuth()
@Controller('library')
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  @Get('usage')
  @Roles(...OWNERS)
  usage(@CurrentUser() user: JwtUser, @Lang() locale: Locale) {
    return this.library.usage(user, locale);
  }

  // ───── Folders ─────

  @Get('folders')
  @Roles(...OWNERS, 'STUDENT')
  folders(@CurrentUser() user: JwtUser, @Query() query: ScopeQuery) {
    return this.library.listFolders(user, query.scope);
  }

  @Get('student-folders')
  @Roles(...OWNERS)
  studentFolders(@CurrentUser() user: JwtUser) {
    return this.library.studentFolders(user);
  }

  @Post('folders')
  @Roles(...OWNERS)
  createFolder(@CurrentUser() user: JwtUser, @Body() dto: CreateFolderDto) {
    return this.library.createFolder(user, dto);
  }

  @Post('student-folders/:studentId')
  @Roles(...OWNERS)
  ensureStudentFolder(@CurrentUser() user: JwtUser, @Param('studentId', ParseUUIDPipe) studentId: string) {
    return this.library.ensureStudentFolder(user, studentId);
  }

  @Patch('folders/:id')
  @Roles(...OWNERS)
  updateFolder(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFolderDto) {
    return this.library.updateFolder(user, id, dto);
  }

  @Delete('folders/:id')
  @Roles(...OWNERS)
  @HttpCode(204)
  removeFolder(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.library.removeFolder(user, id);
  }

  // ───── Files ─────

  @Get('files')
  @Roles(...OWNERS, 'STUDENT')
  files(@CurrentUser() user: JwtUser, @Query() query: ListFilesQuery) {
    return this.library.listFiles(user, query);
  }

  /** One file per request, so the client can show per-file progress and cancel. */
  @Post('files')
  @Roles(...OWNERS)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  upload(@CurrentUser() user: JwtUser, @UploadedFile() file: UploadedTempFile | undefined, @Body() dto: UploadFileDto) {
    return this.library.upload(user, file, dto);
  }

  @Patch('files/:id')
  @Roles(...OWNERS)
  updateFile(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFileDto) {
    return this.library.updateFile(user, id, dto);
  }

  @Delete('files/:id')
  @Roles(...OWNERS)
  @HttpCode(204)
  async removeFile(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.library.removeFiles(user, [id]);
  }

  @Post('files/move')
  @Roles(...OWNERS)
  @HttpCode(200)
  moveFiles(@CurrentUser() user: JwtUser, @Body() dto: MoveFilesDto) {
    return this.library.moveFiles(user, dto);
  }

  @Post('files/delete')
  @Roles(...OWNERS)
  @HttpCode(200)
  removeFiles(@CurrentUser() user: JwtUser, @Body() dto: FileIdsDto) {
    return this.library.removeFiles(user, dto.ids);
  }

  /** Adds center-library files to the caller's own library (no storage used). */
  @Post('files/import')
  @Roles(...OWNERS)
  @HttpCode(200)
  importShared(@CurrentUser() user: JwtUser, @Body() dto: ImportFilesDto) {
    return this.library.importShared(user, dto);
  }

  @Post('files/send')
  @Roles(...OWNERS)
  @HttpCode(200)
  send(@CurrentUser() user: JwtUser, @Body() dto: SendFilesDto) {
    return this.library.sendToStudents(user, dto);
  }

  // ───── Signed file access (used by <img>, <video>, <iframe> and downloads) ─────

  // A library page loads dozens of thumbnails at once; signed links are their own protection.
  @Public()
  @SkipThrottle()
  @Get('blob/:token')
  @ApiExcludeEndpoint()
  blob(@Param('token') token: string, @Lang() locale: Locale, @Res() res: Response) {
    const grant = this.library.readGrant(token);
    if (!grant) throw new NotFoundException(msg('library.invalidLink'));

    const fallback = grant.n.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
    const disposition = `${grant.d ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(grant.n)}`;

    res.sendFile(
      this.library.blobPath(grant.k),
      {
        headers: {
          'Content-Type': grant.t,
          'Content-Disposition': disposition,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=3600',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        },
      },
      (err) => {
        if (err && !res.headersSent) {
          res.status(404).json({ statusCode: 404, message: translate(locale, 'library.fileNotFound'), error: 'Not Found' });
        }
      },
    );
  }
}
