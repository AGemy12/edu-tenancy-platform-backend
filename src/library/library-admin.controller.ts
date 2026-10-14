import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { LibraryAdminService } from './library-admin.service.js';
import { ListBlobsQuery, UpdateMemberDto } from './dto/library.dto.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Lang } from '../i18n/lang.decorator.js';
import type { Locale } from '../i18n/locale.js';

@ApiTags('library-admin')
@ApiBearerAuth()
@Controller('library/admin')
@Roles('TENANT_ADMIN')
export class LibraryAdminController {
  constructor(private readonly admin: LibraryAdminService) {}

  @Get('overview')
  overview(@CurrentUser() user: JwtUser, @Lang() locale: Locale) {
    return this.admin.overview(user, locale);
  }

  @Patch('members/:userId')
  updateMember(
    @CurrentUser() user: JwtUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateMemberDto,
    @Lang() locale: Locale,
  ) {
    return this.admin.updateMember(user, userId, dto, locale);
  }

  @Get('blobs')
  blobs(@CurrentUser() user: JwtUser, @Query() query: ListBlobsQuery) {
    return this.admin.blobs(user, query);
  }

  @Delete('blobs/:id')
  @HttpCode(204)
  deleteBlob(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.deleteBlob(user, id);
  }
}
