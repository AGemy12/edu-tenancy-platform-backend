import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PlatformService } from './platform.service.js';
import { Roles } from '../common/decorators/roles.decorator.js';

@ApiTags('platform')
@ApiBearerAuth()
@Controller('platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  /** Super admin: MRR and its movements over 12 months, churn and trial conversion. */
  @Get('metrics')
  @Roles('SUPER_ADMIN')
  metrics() {
    return this.platform.metrics();
  }

  /** Super admin: centers at risk of leaving and centers outgrowing their package. */
  @Get('health')
  @Roles('SUPER_ADMIN')
  health() {
    return this.platform.health();
  }
}
