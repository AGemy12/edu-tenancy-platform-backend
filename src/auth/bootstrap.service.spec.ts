import { vi } from 'vitest';
import { BootstrapService } from './bootstrap.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ConfigService } from '@nestjs/config';

function setup(env: Record<string, string>, admins = 0) {
  const prisma = { user: { count: vi.fn().mockResolvedValue(admins), upsert: vi.fn() } };
  const config = { get: (k: string) => env[k] };
  return { prisma, service: new BootstrapService(prisma as unknown as PrismaService, config as unknown as ConfigService) };
}

describe('BootstrapService', () => {
  it('creates the platform admin on a fresh deployment', async () => {
    const { prisma, service } = setup({ PLATFORM_ADMIN_EMAIL: ' Ops@Example.com ', PLATFORM_ADMIN_PASSWORD: 'Strong#Pass1' });
    await service.ensurePlatformAdmin();
    const call = prisma.user.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ email: 'ops@example.com' });
    expect(call.create).toMatchObject({ email: 'ops@example.com', isPlatformAdmin: true });
    expect(call.create.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(call.update).toEqual({ isPlatformAdmin: true });
  });

  it('does nothing once an operator exists, without the variables, or with a weak password', async () => {
    const existing = setup({ PLATFORM_ADMIN_EMAIL: 'ops@example.com', PLATFORM_ADMIN_PASSWORD: 'Strong#Pass1' }, 1);
    await existing.service.ensurePlatformAdmin();
    expect(existing.prisma.user.upsert).not.toHaveBeenCalled();

    const unset = setup({});
    await unset.service.ensurePlatformAdmin();
    expect(unset.prisma.user.count).not.toHaveBeenCalled();

    const weak = setup({ PLATFORM_ADMIN_EMAIL: 'ops@example.com', PLATFORM_ADMIN_PASSWORD: 'password' });
    await weak.service.ensurePlatformAdmin();
    expect(weak.prisma.user.upsert).not.toHaveBeenCalled();
  });
});
