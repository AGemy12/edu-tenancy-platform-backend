import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CoursesService } from './courses.service.js';
import { CreateCourseDto, EnrollDto, UpdateCourseDto } from './dto/course.dto.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';

@ApiTags('courses')
@ApiBearerAuth()
@Controller('courses')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get()
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  list(@CurrentUser() user: JwtUser) {
    return this.courses.list(user);
  }

  @Get(':id')
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  get(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.courses.get(user, id);
  }

  @Post()
  @Roles('TENANT_ADMIN', 'TEACHER')
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateCourseDto) {
    return this.courses.create(user, dto);
  }

  @Patch(':id')
  @Roles('TENANT_ADMIN', 'TEACHER')
  update(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: UpdateCourseDto) {
    return this.courses.update(user, id, dto);
  }

  @Delete(':id')
  @Roles('TENANT_ADMIN', 'TEACHER')
  @HttpCode(204)
  remove(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.courses.remove(user, id);
  }

  @Post(':id/enrollments')
  @Roles('TENANT_ADMIN', 'TEACHER')
  enroll(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: EnrollDto) {
    return this.courses.enroll(user, id, dto.studentId);
  }

  @Delete(':id/enrollments/:studentId')
  @Roles('TENANT_ADMIN', 'TEACHER')
  @HttpCode(204)
  unenroll(@CurrentUser() user: JwtUser, @Param('id') id: string, @Param('studentId') studentId: string) {
    return this.courses.unenroll(user, id, studentId);
  }
}
