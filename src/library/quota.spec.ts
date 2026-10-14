import {
  MB,
  addOnMb,
  allocatedMb,
  formatMb,
  maxAllocationMb,
  personalQuotaBytes,
  poolMb,
  sharedQuotaBytes,
  type AddOn,
  type Member,
} from './quota.js';

const plan = { storagePerTeacherMb: 5120, sharedStorageMb: 10240, maxFileMb: 100 };
const now = new Date('2026-10-13T12:00:00Z');
const addOn = (userId: string | null, extraMb: number, from: string, to: string | null = null): AddOn => ({
  userId,
  extraMb,
  startsAt: new Date(from),
  expiresAt: to ? new Date(to) : null,
});

describe('storage quotas', () => {
  const members: Member[] = [
    { id: 'admin', storageQuotaMb: null },
    { id: 'ahmed', storageQuotaMb: 8192 },
    { id: 'sara', storageQuotaMb: 2048 },
  ];

  it('gives every member the package default unless the admin set an allocation', () => {
    expect(personalQuotaBytes(plan, members[0], [], now)).toBe(5120 * MB);
    expect(personalQuotaBytes(plan, members[1], [], now)).toBe(8192 * MB);
  });

  it('pools per-teacher space across members and lets the admin only redistribute it', () => {
    expect(poolMb(plan, members.length)).toBe(15360);
    expect(allocatedMb(plan, members)).toBe(5120 + 8192 + 2048);
    // Sara can grow up to what the others leave free: 15360 − (5120 + 8192).
    expect(maxAllocationMb(plan, members, 'sara')).toBe(2048);
    expect(maxAllocationMb(plan, members, 'admin')).toBe(5120);
  });

  it('never reports a negative allowance when the pool is over-allocated (a teacher was removed)', () => {
    const over: Member[] = [
      { id: 'a', storageQuotaMb: 9000 },
      { id: 'b', storageQuotaMb: 9000 },
    ];
    expect(maxAllocationMb(plan, over, 'a')).toBe(1240);
    expect(maxAllocationMb(plan, [{ id: 'x', storageQuotaMb: 20000 }, { id: 'y', storageQuotaMb: null }], 'y')).toBe(0);
  });

  it('adds only active add-ons, per member or for the center library', () => {
    const addOns = [
      addOn('ahmed', 1024, '2026-01-01'),
      addOn('ahmed', 2048, '2026-01-01', '2026-06-01'), // expired
      addOn('ahmed', 512, '2027-01-01'), // not started
      addOn(null, 4096, '2026-01-01'),
    ];
    expect(addOnMb(addOns, 'ahmed', now)).toBe(1024);
    expect(personalQuotaBytes(plan, members[1], addOns, now)).toBe((8192 + 1024) * MB);
    expect(sharedQuotaBytes(plan, addOns, now)).toBe((10240 + 4096) * MB);
  });

  it('formats sizes for messages', () => {
    expect(formatMb(512)).toBe('512 MB');
    expect(formatMb(5120)).toBe('5 GB');
    expect(formatMb(1536)).toBe('1.5 GB');
  });
});
