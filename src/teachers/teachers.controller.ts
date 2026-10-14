import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TeachersService } from './teachers.service.js';
import { CreateTeacherDto, UpdateTeacherDto } from './dto/teacher.dto.js';
import { SetAccountStatusDto } from '../auth/dto/account-status.dto.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Lang } from '../i18n/lang.decorator.js';
import type { Locale } from '../i18n/locale.js';

@ApiTags('teachers')
@ApiBearerAuth()
@Controller('teachers')
export class TeachersController {
  constructor(private readonly teachers: TeachersService) {}

  @Get()
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  list(@CurrentUser('tenantId') tenantId: string) {
    return this.teachers.list(tenantId);
  }

  @Get(':id')
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  get(@CurrentUser('tenantId') tenantId: string, @Param('id') id: string) {
    return this.teachers.get(tenantId, id);
  }

  @Post()
  @Roles('TENANT_ADMIN')
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateTeacherDto, @Lang() locale: Locale) {
    return this.teachers.create(user, dto, locale);
  }

  /** The tenant admin teaches too, from the same login. */
  @Post('me')
  @Roles('TENANT_ADMIN')
  addSelf(@CurrentUser() user: JwtUser) {
    return this.teachers.addSelf(user);
  }

  @Patch(':id')
  @Roles('TENANT_ADMIN')
  update(@CurrentUser('tenantId') tenantId: string, @Param('id') id: string, @Body() dto: UpdateTeacherDto) {
    return this.teachers.update(tenantId, id, dto);
  }

  /** Suspend (read-only), block (no sign-in) or reactivate the teacher's account. */
  @Patch(':id/status')
  @Roles('TENANT_ADMIN')
  setStatus(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: SetAccountStatusDto) {
    return this.teachers.setStatus(user, id, dto);
  }

  @Delete(':id')
  @Roles('TENANT_ADMIN')
  @HttpCode(204)
  remove(@CurrentUser('tenantId') tenantId: string, @Param('id') id: string) {
    return this.teachers.remove(tenantId, id);
  }
}
