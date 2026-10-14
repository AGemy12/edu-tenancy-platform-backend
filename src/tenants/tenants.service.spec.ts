import { NotFoundException } from '@nestjs/common';
import { vi } from 'vitest';
import { TenantsService } from './tenants.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SubscriptionAccess } from './subscription.guard.js';

const future = new Date(Date.now() + 10 * 86_400_000);
const past = new Date(Date.now() - 86_400_000);
const owner = { user: { fullName: 'Ahmed', email: 'owner@x.test', lastLoginAt: past } };
const plan = { id: 'p1', code: 'PRO', nameAr: 'احترافية', nameEn: 'Pro', maxTeachers: 10, maxStudents: 100, storagePerTeacherMb: 512, sharedStorageMb: 2048, maxFileMb: 50, priceMonthly: { toString: () => '499.00' }, currency: 'EGP' };

function setup() {
  const prisma = {
    tenant: {
      findMany: vi.fn().mockResolvedValue([
        { id: 't1', name: 'Center', slug: 'center', status: 'ACTIVE', createdAt: past, subscription: { status: 'ACTIVE', currentPeriodEnd: future, plan }, memberships: [owner], _count: { memberships: 3, teachers: 1, students: 1, courses: 2, sessions: 9 } },
        { id: 't2', name: 'Empty', slug: 'empty', status: 'ACTIVE', createdAt: past, subscription: { status: 'TRIALING', currentPeriodEnd: past, plan }, memberships: [], _count: { memberships: 0, teachers: 0, students: 0, courses: 0, sessions: 0 } },
      ]),
      findUnique: vi.fn().mockResolvedValue({
        id: 't1', name: 'Center', slug: 'center', status: 'ACTIVE', timezone: 'Africa/Cairo', currency: 'EGP', createdAt: past, updatedAt: past,
        subscription: { status: 'ACTIVE', currentPeriodStart: past, currentPeriodEnd: future, plan },
        memberships: [
          { id: 'm1', role: 'TENANT_ADMIN', status: 'ACTIVE', statusReason: null, createdAt: past, user: { id: 'u1', fullName: 'Ahmed', email: 'owner@x.test', lastLoginAt: past } },
          { id: 'm2', role: 'TEACHER', status: 'SUSPENDED', statusReason: 'dues', createdAt: past, user: { id: 'u2', fullName: 'Mona', email: 't@x.test', lastLoginAt: null } },
        ],
        integrations: [{ provider: 'ZOOM', user: { fullName: 'Mona' } }],
        _count: { teachers: 1, students: 1, courses: 2, exams: 1, sessions: 9 },
      }),
    },
    session: {
      groupBy: vi.fn().mockResolvedValue([{ status: 'COMPLETED', _count: { _all: 7 } }, { status: 'CANCELED', _count: { _all: 2 } }]),
      count: vi.fn().mockResolvedValue(4),
    },
    storedBlob: {
      groupBy: vi.fn().mockResolvedValue([{ tenantId: 't1', _sum: { size: 1_500_000 } }]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { size: 1_500_000 } }),
    },
  };
  return { prisma, service: new TenantsService(prisma as unknown as PrismaService, {} as SubscriptionAccess) };
}

describe('TenantsService (super admin)', () => {
  it('lists every center with its owner, storage and whether the period lapsed', async () => {
    const { service } = setup();
    const [a, b] = await service.listAll();
    expect(a).toMatchObject({ id: 't1', owner: owner.user, storageBytes: 1_500_000, subscriptionExpired: false });
    expect(b).toMatchObject({ id: 't2', owner: null, storageBytes: 0, subscriptionExpired: true });
    expect('memberships' in a).toBe(false);
  });

  it('describes one center: limits, members with their state, activity and integrations', async () => {
    const { service } = setup();
    const d = await service.detail('t1');
    expect(d.subscription?.plan).toMatchObject({ maxTeachers: 10, priceMonthly: '499.00' });
    expect(d.members).toHaveLength(2);
    expect(d.members[1]).toMatchObject({ role: 'TEACHER', status: 'SUSPENDED', statusReason: 'dues', user: { email: 't@x.test' } });
    expect(d.sessions).toEqual({ last30Days: 4, byStatus: { COMPLETED: 7, CANCELED: 2 } });
    expect(d.integrations).toEqual([{ provider: 'ZOOM', user: 'Mona' }]);
    expect(d.counts.courses).toBe(2);
    expect(d.lastLoginAt).toEqual(past);
  });

  it('404s for an unknown center', async () => {
    const { prisma, service } = setup();
    prisma.tenant.findUnique.mockResolvedValue(null);
    await expect(service.detail('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
