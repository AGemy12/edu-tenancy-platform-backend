import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ExamsService } from './exams.service.js';
import { CreateExamDto, GradeDto, GradeManyDto, UpdateExamDto } from './dto/exam.dto.js';
import { CurrentUser, type JwtUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';

@ApiTags('exams')
@ApiBearerAuth()
@Controller('exams')
export class ExamsController {
  constructor(private readonly exams: ExamsService) {}

  @Get()
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  list(@CurrentUser() user: JwtUser, @Query('month') month?: string) {
    return this.exams.list(user, month);
  }

  @Get(':id')
  @Roles('TENANT_ADMIN', 'TEACHER', 'STUDENT')
  get(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.exams.get(user, id);
  }

  @Post()
  @Roles('TENANT_ADMIN', 'TEACHER')
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateExamDto) {
    return this.exams.create(user, dto);
  }

  @Patch(':id')
  @Roles('TENANT_ADMIN', 'TEACHER')
  update(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: UpdateExamDto) {
    return this.exams.update(user, id, dto);
  }

  /** Grading sheet: enrolled students with their marks so far. */
  @Get(':id/roster')
  @Roles('TENANT_ADMIN', 'TEACHER')
  roster(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.exams.roster(user, id);
  }

  /** Saves the whole grading sheet at once. */
  @Post(':id/results/bulk')
  @Roles('TENANT_ADMIN', 'TEACHER')
  @HttpCode(200)
  gradeMany(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: GradeManyDto) {
    return this.exams.gradeMany(user, id, dto);
  }

  @Post(':id/results')
  @Roles('TENANT_ADMIN', 'TEACHER')
  grade(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: GradeDto) {
    return this.exams.grade(user, id, dto);
  }

  @Delete(':id')
  @Roles('TENANT_ADMIN', 'TEACHER')
  @HttpCode(204)
  remove(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.exams.remove(user, id);
  }
}
