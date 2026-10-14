import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StudentsService } from './students.service.js';
import { CreateStudentDto, LinkTeacherDto, UpdateStudentDto } from './dto/student.dto.js';
import { SetAccountStatusDto } from '../auth/dto/account-status.dto.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Lang } from '../i18n/lang.decorator.js';
import type { Locale } from '../i18n/locale.js';

@ApiTags('students')
@ApiBearerAuth()
@Controller('students')
@Roles('TENANT_ADMIN', 'TEACHER')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get()
  list(@CurrentUser() user: JwtUser) {
    return this.students.list(user);
  }

  @Get(':id')
  get(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.students.get(user, id);
  }

  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateStudentDto, @Lang() locale: Locale) {
    return this.students.create(user, dto, locale);
  }

  @Patch(':id')
  update(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: UpdateStudentDto) {
    return this.students.update(user, id, dto);
  }

  /** Suspend (read-only), block (no sign-in) or reactivate the student's account. */
  @Patch(':id/status')
  setStatus(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: SetAccountStatusDto) {
    return this.students.setStatus(user, id, dto);
  }

  @Post(':id/teachers')
  linkTeacher(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: LinkTeacherDto) {
    return this.students.linkTeacher(user, id, dto.teacherId);
  }

  @Delete(':id/teachers/:teacherId')
  @HttpCode(204)
  unlinkTeacher(@CurrentUser() user: JwtUser, @Param('id') id: string, @Param('teacherId') teacherId: string) {
    return this.students.unlinkTeacher(user, id, teacherId);
  }

  @Delete(':id')
  @Roles('TENANT_ADMIN')
  @HttpCode(204)
  remove(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.students.remove(user, id);
  }
}
