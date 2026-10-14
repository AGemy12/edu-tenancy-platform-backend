import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service.js';
import { passwordProblems } from './password-policy.js';

/**
 * First-run setup for a fresh deployment: creates the platform operator's account from
 * PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD when no operator exists yet. It never changes
 * an existing account, so the variables can stay set (or be removed) after the first start.
 */
@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    await this.ensurePlatformAdmin();
  }

  async ensurePlatformAdmin() {
    const email = this.config.get<string>('PLATFORM_ADMIN_EMAIL')?.trim().toLowerCase();
    const password = this.config.get<string>('PLATFORM_ADMIN_PASSWORD');
    if (!email || !password) return;

    const existing = await this.prisma.user.count({ where: { isPlatformAdmin: true } });
    if (existing > 0) return;

    if (passwordProblems(password).length > 0) {
      this.logger.error('PLATFORM_ADMIN_PASSWORD does not meet the password policy; no platform admin was created');
      return;
    }
    const passwordHash = await bcrypt.hash(password, 10);
    // The email may already belong to a center member: promote that account instead of failing.
    await this.prisma.user.upsert({
      where: { email },
      update: { isPlatformAdmin: true },
      create: { email, passwordHash, fullName: this.config.get<string>('PLATFORM_ADMIN_NAME')?.trim() || 'Platform Admin', isPlatformAdmin: true },
    });
    this.logger.log(`Platform admin ready: ${email}`);
  }
}
