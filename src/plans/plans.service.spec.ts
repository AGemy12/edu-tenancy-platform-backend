import { ConflictException, NotFoundException } from '@nestjs/common';
import { vi } from 'vitest';
import { PlansService } from './plans.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const row = { id: 'p1', code: 'BASIC', nameAr: 'أساسية', nameEn: 'Basic', priceMonthly: { toString: () => '499.00' }, currency: 'EGP', _count: { subscriptions: 2 } };
const dto = { code: 'TEAM', nameAr: 'فريق', nameEn: 'Team', maxTeachers: 20, maxStudents: 500, storagePerTeacherMb: 1024, sharedStorageMb: 4096, maxFileMb: 100, currency: 'egp' };

function setup(existing: object | null = null, subscriptions = 0) {
  const prisma = {
    plan: {
      findUnique: vi.fn().mockImplementation(({ where }) => Promise.resolve(where.code ? existing : existing && { ...row, _count: { subscriptions } })),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...row, ...data, _count: { subscriptions: 0 } })),
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...row, ...data })),
      delete: vi.fn(),
    },
  };
  return { prisma, service: new PlansService(prisma as unknown as PrismaService) };
}

describe('PlansService (super admin)', () => {
  it('creates a package, normalising the currency, and reports its subscriber count', async () => {
    const { prisma, service } = setup();
    const created = await service.create(dto);
    expect(prisma.plan.create.mock.calls[0][0].data.currency).toBe('EGP');
    expect(created).toMatchObject({ code: 'TEAM', tenants: 0 });
    expect('_count' in created).toBe(false);
  });

  it('refuses a duplicate code', async () => {
    const { service } = setup(row);
    await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
  });

  it('deletes only a package no center is on; otherwise it must be retired', async () => {
    const free = setup(row, 0);
    await free.service.remove('p1');
    expect(free.prisma.plan.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });

    const used = setup(row, 2);
    await expect(used.service.remove('p1')).rejects.toMatchObject({ response: { i18n: 'plans.inUse', params: { count: 2 } } });
    expect(used.prisma.plan.delete).not.toHaveBeenCalled();

    await expect(setup(null).service.update('nope', { isPublic: false })).rejects.toBeInstanceOf(NotFoundException);
  });
});
