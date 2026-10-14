import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlansService } from '../plans/plans.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Locale } from '../i18n/locale.js';
import { msg } from '../i18n/i18n.js';
import { LibraryService } from './library.service.js';
import { QuotaService } from './quota.service.js';
import type { ListBlobsQuery, UpdateMemberDto } from './dto/library.dto.js';
import { MB, addOnMb, allocatedMb, baseQuotaMb, formatMb, maxAllocationMb, poolMb, sharedQuotaBytes } from './quota.js';

/**
 * The center admin's storage monitor: who uses how much, allocations, the center library and
 * the largest files. File contents are never exposed here (names, types and sizes only).
 */
@Injectable()
export class LibraryAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: QuotaService,
    private readonly plans: PlansService,
    private readonly library: LibraryService,
  ) {}

  async overview(user: JwtUser, locale: Locale) {
    const tenantId = user.tenantId!;
    await this.library.releaseOrphans(tenantId);
    const [plan, addOns, members, usage, blobCount, sharedFiles] = await Promise.all([
      this.quota.plan(tenantId),
      this.quota.addOns(tenantId),
      this.quota.members(tenantId),
      this.prisma.storedBlob.groupBy({
        by: ['chargedToId'],
        where: { tenantId },
        _sum: { size: true },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      this.prisma.storedBlob.count({ where: { tenantId } }),
      this.prisma.libraryFile.count({ where: { tenantId, scope: 'SHARED' } }),
    ]);
    const usageBy = new Map(usage.map((u) => [u.chargedToId, u]));
    const sharedUsage = usageBy.get(null);

    return {
      plan: this.plans.summary(plan, locale),
      pool: { totalMb: poolMb(plan, members.length), allocatedMb: allocatedMb(plan, members) },
      shared: {
        usedBytes: sharedUsage?._sum.size ?? 0,
        quotaBytes: sharedQuotaBytes(plan, addOns),
        files: sharedFiles,
        addOnMb: addOnMb(addOns, null),
      },
      totals: { usedBytes: usage.reduce((s, u) => s + (u._sum.size ?? 0), 0), files: blobCount },
      members: members
        .map((m) => {
          const u = usageBy.get(m.id);
          const base = baseQuotaMb(plan, m);
          const extra = addOnMb(addOns, m.id);
          return {
            userId: m.id,
            teacherId: m.teacher?.id ?? null,
            fullName: m.fullName,
            email: m.email,
            role: m.role as 'TENANT_ADMIN' | 'TEACHER',
            status: m.status,
            usedBytes: u?._sum.size ?? 0,
            quotaBytes: (base + extra) * MB,
            baseQuotaMb: base,
            customQuota: m.storageQuotaMb !== null,
            addOnMb: extra,
            files: u?._count._all ?? 0,
            lastUploadAt: u?._max.createdAt ?? null,
            canManageShared: m.role === 'TENANT_ADMIN' || Boolean(m.teacher?.canManageSharedLibrary),
          };
        })
        .sort((a, b) => (a.role === b.role ? b.usedBytes - a.usedBytes : a.role === 'TENANT_ADMIN' ? -1 : 1)),
    };
  }

  async updateMember(user: JwtUser, userId: string, dto: UpdateMemberDto, locale: Locale) {
    const tenantId = user.tenantId!;
    const [plan, members] = await Promise.all([this.quota.plan(tenantId), this.quota.members(tenantId)]);
    const member = members.find((m) => m.id === userId);
    if (!member) throw new NotFoundException(msg('library.memberNotFound'));

    if (dto.storageQuotaMb !== undefined) {
      // Redistribution only: the total of base allocations stays within the package pool.
      const max = maxAllocationMb(plan, members, userId);
      const wanted = dto.storageQuotaMb ?? plan.storagePerTeacherMb;
      if (wanted > max) throw new BadRequestException(msg('library.allocationExceedsPool', { available: formatMb(max) }));
      await this.prisma.membership.update({ where: { id: member.membershipId }, data: { storageQuotaMb: dto.storageQuotaMb } });
    }
    if (dto.canManageShared !== undefined && member.teacher) {
      await this.prisma.teacher.update({ where: { id: member.teacher.id }, data: { canManageSharedLibrary: dto.canManageShared } });
    }

    const { members: updated } = await this.overview(user, locale);
    return updated.find((m) => m.userId === userId)!;
  }

  /** Largest stored files first; each row is one blob shared by its original and all copies. */
  async blobs(user: JwtUser, query: ListBlobsQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const where: Prisma.StoredBlobWhereInput = { tenantId: user.tenantId!, files: { some: {} } };
    if (query.shared) where.chargedToId = null;
    else if (query.userId) where.chargedToId = query.userId;

    const [rows, total] = await Promise.all([
      this.prisma.storedBlob.findMany({
        where,
        orderBy: [{ size: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          size: true,
          createdAt: true,
          chargedTo: { select: { id: true, fullName: true } },
          _count: { select: { files: true } },
          files: { take: 1, orderBy: { createdAt: 'asc' }, select: { name: true, extension: true, kind: true } },
        },
      }),
      this.prisma.storedBlob.count({ where }),
    ]);
    const studentCopies = await this.prisma.libraryFile.groupBy({
      by: ['blobId'],
      where: { blobId: { in: rows.map((r) => r.id) }, folder: { studentId: { not: null } } },
      _count: { _all: true },
    });
    const copiesBy = new Map(studentCopies.map((c) => [c.blobId, c._count._all]));

    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.files[0]?.name ?? '',
        extension: r.files[0]?.extension ?? '',
        kind: r.files[0]?.kind ?? 'OTHER',
        size: r.size,
        createdAt: r.createdAt,
        chargedTo: r.chargedTo,
        references: r._count.files,
        studentCopies: copiesBy.get(r.id) ?? 0,
      })),
      total,
      page,
      pageSize,
    };
  }

  /** Frees the space: deletes the blob with its original and every copy (students' too). */
  async deleteBlob(user: JwtUser, id: string) {
    const blob = await this.prisma.storedBlob.findFirst({ where: { id, tenantId: user.tenantId! }, select: { id: true } });
    if (!blob) throw new NotFoundException(msg('library.fileNotFound'));
    await this.prisma.libraryFile.deleteMany({ where: { blobId: id, tenantId: user.tenantId! } });
    await this.library.releaseBlobs([id]);
  }
}
