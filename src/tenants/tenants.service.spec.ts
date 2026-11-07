import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { vi } from 'vitest';
import { TenantsService } from './tenants.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SubscriptionAccess } from './subscription.guard.js';
import type { AuthService } from '../auth/auth.service.js';

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
      update: vi.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, platformFeePercent: data.platformFeePercent })),
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      findUnique: vi.fn().mockResolvedValue({
        id: 't1', name: 'Center', slug: 'center', status: 'ACTIVE', timezone: 'Africa/Cairo', currency: 'EGP', platformFeePercent: { toString: () => '12.5' }, createdAt: past, updatedAt: past,
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
  const auth = { sendWelcome: vi.fn() };
  return { prisma, auth, service: new TenantsService(prisma as unknown as PrismaService, { forget: vi.fn() } as unknown as SubscriptionAccess, auth as unknown as AuthService, new Proxy({}, { get: () => vi.fn() }) as never) };
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
    expect(d.platformFeePercent).toBe(12.5);
  });

  it("sets a center's own fee, or returns it to its package's", async () => {
    const { prisma, service } = setup();
    prisma.tenant.update.mockImplementation(({ where, data }) =>
      Promise.resolve({ id: where.id, platformFeePercent: data.platformFeePercent, subscription: { plan: { platformFeePercent: { toString: () => '8' } } } }),
    );
    expect(await service.setPlatformFee('t1', 15)).toEqual({ id: 't1', platformFeePercent: 15, platformFeeOverride: 15 });
    expect(await service.setPlatformFee('t1', null)).toEqual({ id: 't1', platformFeePercent: 8, platformFeeOverride: null });
    expect(await service.setPlatformFee('t1', 0)).toEqual({ id: 't1', platformFeePercent: null, platformFeeOverride: 0 });
    expect(prisma.tenant.update).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: 't1' }, data: { platformFeePercent: 0 } }));
  });

  it('applies one commission to chosen centers, or to all but some', async () => {
    const { prisma, service } = setup();
    await service.bulkPlatformFee({ percent: 10, tenantIds: ['t1', 't2', 't1'], except: ['t2'] });
    expect(prisma.tenant.updateMany).toHaveBeenLastCalledWith({ where: { id: { in: ['t1'] } }, data: { platformFeePercent: 10 } });
    await service.bulkPlatformFee({ percent: null, except: ['t3'] });
    expect(prisma.tenant.updateMany).toHaveBeenLastCalledWith({ where: { id: { notIn: ['t3'] } }, data: { platformFeePercent: null } });
    expect(await service.bulkPlatformFee({ percent: 7 })).toEqual({ updated: 2, percent: 7 });
    expect(prisma.tenant.updateMany).toHaveBeenLastCalledWith({ where: {}, data: { platformFeePercent: 7 } });
    await expect(service.bulkPlatformFee({ percent: 7, tenantIds: [] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records every subscription change in the history, with who made it', async () => {
    const { prisma, service } = setup();
    const sub = { planId: 'p1', status: 'ACTIVE', currentPeriodEnd: future, plan: { priceMonthly: plan.priceMonthly, currency: 'EGP' } };
    const tx = {
      subscription: { update: vi.fn(), create: vi.fn(), findUnique: vi.fn().mockResolvedValue(sub) },
      subscriptionChange: { create: vi.fn() },
    };
    Object.assign(prisma, {
      subscription: { findUnique: vi.fn().mockResolvedValue({ tenantId: 't1' }) },
      $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    });
    await service.updateSubscription('t1', { status: 'ACTIVE', currentPeriodEnd: future.toISOString() }, 'admin-1');
    expect(tx.subscription.update).toHaveBeenCalledWith({ where: { tenantId: 't1' }, data: { planId: undefined, status: 'ACTIVE', currentPeriodEnd: future } });
    expect(tx.subscriptionChange.create).toHaveBeenCalledWith({
      data: { tenantId: 't1', planId: 'p1', status: 'ACTIVE', currentPeriodEnd: future, priceMonthly: plan.priceMonthly, currency: 'EGP', actorId: 'admin-1' },
    });
  });

  describe('create (super admin)', () => {
    const dto = { name: ' New Center ', slug: 'new-center', ownerName: 'Sara', ownerEmail: ' Sara@X.test ', planId: 'p1', status: 'TRIALING' as const, currentPeriodEnd: future.toISOString() };

    function withTx(existingUser: { id: string } | null) {
      const { prisma, auth, service } = setup();
      const tx = {
        user: { create: vi.fn().mockResolvedValue({ id: 'u-new' }), update: vi.fn() },
        tenant: { create: vi.fn().mockResolvedValue({ id: 't-new' }) },
        membership: { create: vi.fn().mockResolvedValue({ id: 'm-new' }) },
        subscription: { findUnique: vi.fn().mockResolvedValue({ planId: 'p1', status: 'TRIALING', currentPeriodEnd: future, plan: { priceMonthly: null, currency: 'EGP' } }) },
        subscriptionChange: { create: vi.fn() },
      };
      prisma.tenant.findUnique.mockResolvedValue(null);
      Object.assign(prisma, {
        plan: { findUnique: vi.fn().mockResolvedValue({ isActive: true }) },
        user: { findUnique: vi.fn().mockResolvedValue(existingUser) },
        $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
      });
      return { prisma, auth, service, tx };
    }

    it('creates the center, its owner, the subscription and its first history row, then welcomes the owner', async () => {
      const { auth, service, tx } = withTx(null);
      await service.create(dto, 'admin-1', 'en');
      expect(tx.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ email: 'sara@x.test', fullName: 'Sara' }) }));
      expect(tx.tenant.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'New Center', slug: 'new-center', subscription: { create: { planId: 'p1', status: 'TRIALING', currentPeriodEnd: future } } }) }),
      );
      expect(tx.subscriptionChange.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: 't-new', actorId: 'admin-1' }) });
      expect(tx.membership.create).toHaveBeenCalledWith({ data: { userId: 'u-new', tenantId: 't-new', role: 'TENANT_ADMIN' }, select: { id: true } });
      expect(auth.sendWelcome).toHaveBeenCalledWith('m-new', { existingAccount: false }, 'en');
    });

    it('adds the center to an existing account instead of making a second one', async () => {
      const { auth, service, tx } = withTx({ id: 'u-old' });
      await service.create({ ...dto, currentPeriodEnd: null }, 'admin-1');
      expect(tx.user.create).not.toHaveBeenCalled();
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.membership.create).toHaveBeenCalledWith(expect.objectContaining({ data: { userId: 'u-old', tenantId: 't-new', role: 'TENANT_ADMIN' } }));
      expect(tx.tenant.create.mock.calls[0][0].data.subscription.create.currentPeriodEnd).toBeNull();
      expect(auth.sendWelcome).toHaveBeenCalledWith('m-new', { existingAccount: true }, undefined);
    });

    it('refuses a taken slug and a retired package', async () => {
      const { prisma, service } = withTx(null);
      prisma.tenant.findUnique.mockResolvedValueOnce({ id: 'x' });
      await expect(service.create(dto, 'admin-1')).rejects.toBeInstanceOf(ConflictException);
      (prisma as unknown as { plan: { findUnique: ReturnType<typeof vi.fn> } }).plan.findUnique.mockResolvedValue({ isActive: false });
      await expect(service.create(dto, 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('404s for an unknown center', async () => {
    const { prisma, service } = setup();
    prisma.tenant.findUnique.mockResolvedValue(null);
    await expect(service.detail('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
