import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { rm } from 'node:fs/promises';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlansService } from '../plans/plans.service.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';
import type { LibraryScope, Prisma } from '../generated/prisma/client.js';
import type { Locale } from '../i18n/locale.js';
import { StorageService } from './storage.service.js';
import { QuotaService } from './quota.service.js';
import { canRenderInline, cleanFileName, detectType } from './file-types.js';
import { bucketedExpiry, createBlobToken, verifyBlobToken, type BlobGrant } from './signed-url.js';
import type {
  CreateFolderDto,
  ImportFilesDto,
  ListFilesQuery,
  MoveFilesDto,
  SendFilesDto,
  UpdateFileDto,
  UpdateFolderDto,
  UploadFileDto,
} from './dto/library.dto.js';
import { msg } from '../i18n/i18n.js';

/** The parts of a multer upload this service needs (multer writes it to a temp file). */
export type UploadedTempFile = { path: string; originalname: string; size: number };

const MAX_FOLDER_DEPTH = 8;
const URL_TTL_HOURS = 6;
const THUMB_SIZE = 480;

const fileInclude = {
  folder: {
    select: { id: true, name: true, parentId: true, studentId: true, student: { select: { user: { select: { fullName: true } } } } },
  },
  owner: { select: { id: true, fullName: true } },
  blob: { select: { key: true, thumbnailKey: true } },
} satisfies Prisma.LibraryFileInclude;

type FileRow = Prisma.LibraryFileGetPayload<{ include: typeof fileInclude }>;

const folderInclude = {
  student: { select: { id: true, user: { select: { fullName: true } } } },
  owner: { select: { id: true, fullName: true } },
  _count: { select: { files: true, children: true } },
} satisfies Prisma.LibraryFolderInclude;

/**
 * Two libraries share these tables:
 * - PERSONAL: each teacher's (and admin's) own files, including the folders they keep for
 *   their students. Only the owner sees or changes them; students see their folders read-only.
 * - SHARED: the center library. Every teacher and the admin can browse it and send or import
 *   its files; the admin and teachers with `canManageSharedLibrary` can change it.
 * Bytes live in `StoredBlob`, charged to one quota; copies (sent to students, imported) are
 * extra rows on the same blob and cost nothing.
 */
@Injectable()
export class LibraryService {
  private readonly logger = new Logger(LibraryService.name);
  private readonly urlSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly quota: QuotaService,
    private readonly plans: PlansService,
    config: ConfigService,
  ) {
    this.urlSecret = config.get<string>('FILES_URL_SECRET') || config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  // ───────────── Usage ─────────────

  async usage(user: JwtUser, locale: Locale) {
    const tenantId = user.tenantId!;
    const [plan, addOns] = await Promise.all([this.quota.plan(tenantId), this.quota.addOns(tenantId)]);
    const [personal, shared, canManage, personalFiles, sharedFiles] = await Promise.all([
      this.quota.personal(tenantId, user.id, plan, addOns),
      this.quota.shared(tenantId, plan, addOns),
      this.quota.canManageShared(user),
      this.prisma.libraryFile.count({ where: this.fileWhere(user, 'PERSONAL') }),
      this.prisma.libraryFile.count({ where: this.fileWhere(user, 'SHARED') }),
    ]);
    return {
      plan: this.plans.summary(plan, locale),
      maxFileBytes: this.quota.maxFileBytes(plan),
      personal: { ...personal, files: personalFiles },
      shared: { ...shared, files: sharedFiles, canManage },
    };
  }

  // ───────────── Folders ─────────────

  async listFolders(user: JwtUser, scope: LibraryScope = 'PERSONAL') {
    const where: Prisma.LibraryFolderWhereInput =
      user.role === 'STUDENT' ? { tenantId: user.tenantId!, studentId: user.studentId! } : this.folderWhere(user, scope);
    const folders = await this.prisma.libraryFolder.findMany({ where, include: folderInclude, orderBy: { name: 'asc' } });
    return folders.map((f) => this.folderDto(f, user));
  }

  /** Students the user can keep folders for, with their folder (if created yet) and file count. */
  async studentFolders(user: JwtUser) {
    const students = await this.prisma.student.findMany({
      where: this.studentScope(user),
      select: { id: true, grade: true, user: { select: { fullName: true } }, membership: { select: { status: true } } },
      orderBy: { user: { fullName: 'asc' } },
    });
    const [roots, counts] = await Promise.all([
      this.prisma.libraryFolder.findMany({
        where: { ownerId: user.id, scope: 'PERSONAL', parentId: null, studentId: { in: students.map((s) => s.id) } },
        select: { id: true, studentId: true, color: true },
      }),
      this.prisma.$queryRaw<{ studentId: string; files: bigint }[]>`
        SELECT f."studentId", COUNT(*)::bigint AS files
        FROM "LibraryFile" l JOIN "LibraryFolder" f ON f.id = l."folderId"
        WHERE l."ownerId" = ${user.id} AND f."studentId" IS NOT NULL
        GROUP BY f."studentId"`,
    ]);
    const rootBy = new Map(roots.map((r) => [r.studentId, r]));
    const countBy = new Map(counts.map((c) => [c.studentId, Number(c.files)]));
    return students.map((s) => ({
      studentId: s.id,
      fullName: s.user.fullName,
      grade: s.grade,
      status: s.membership.status,
      folderId: rootBy.get(s.id)?.id ?? null,
      color: rootBy.get(s.id)?.color ?? null,
      files: countBy.get(s.id) ?? 0,
    }));
  }

  async createFolder(user: JwtUser, dto: CreateFolderDto) {
    const scope = dto.scope ?? 'PERSONAL';
    if (scope === 'SHARED') await this.quota.assertCanManageShared(user);
    const parent = dto.parentId ? await this.writableFolder(user, dto.parentId, scope) : null;
    if (parent && (await this.depthOf(user, scope, parent.id)) >= MAX_FOLDER_DEPTH) {
      throw new BadRequestException(msg('library.maxDepthCreate', { max: MAX_FOLDER_DEPTH }));
    }
    const folder = await this.prisma.libraryFolder.create({
      data: {
        tenantId: user.tenantId!,
        ownerId: user.id,
        scope,
        parentId: parent?.id ?? null,
        studentId: parent?.studentId ?? null,
        name: dto.name,
        color: dto.color,
      },
      include: folderInclude,
    });
    return this.folderDto(folder, user);
  }

  /** Returns the student's top folder in the user's library, creating it on first use. */
  async ensureStudentFolder(user: JwtUser, studentId: string) {
    const [student] = await this.accessibleStudents(user, [studentId]);
    const existing = await this.prisma.libraryFolder.findFirst({
      where: { ownerId: user.id, scope: 'PERSONAL', studentId, parentId: null },
      include: folderInclude,
    });
    if (existing) return this.folderDto(existing, user);
    const folder = await this.prisma.libraryFolder.create({
      data: { tenantId: user.tenantId!, ownerId: user.id, studentId, name: student.user.fullName, color: 'sky' },
      include: folderInclude,
    });
    return this.folderDto(folder, user);
  }

  async updateFolder(user: JwtUser, id: string, dto: UpdateFolderDto) {
    const folder = await this.writableFolder(user, id);
    const isStudentRoot = folder.studentId !== null && folder.parentId === null;
    const moving = dto.parentId !== undefined && dto.parentId !== folder.parentId;
    if (isStudentRoot && (dto.name !== undefined || moving)) {
      throw new BadRequestException(msg('library.studentRootImmovable'));
    }

    if (!moving) {
      const updated = await this.prisma.libraryFolder.update({
        where: { id },
        data: { name: dto.name, color: dto.color },
        include: folderInclude,
      });
      return this.folderDto(updated, user);
    }

    const target = dto.parentId ? await this.writableFolder(user, dto.parentId, folder.scope) : null;
    const all = await this.prisma.libraryFolder.findMany({
      where: this.folderWhere(user, folder.scope),
      select: { id: true, parentId: true },
    });
    const subtree = descendantsOf(id, all);
    if (target && subtree.includes(target.id)) {
      throw new BadRequestException(msg('library.folderIntoItself'));
    }
    if (target && (await this.depthOf(user, folder.scope, target.id)) + subtreeHeight(id, all) >= MAX_FOLDER_DEPTH) {
      throw new BadRequestException(msg('library.maxDepthMove', { max: MAX_FOLDER_DEPTH }));
    }

    // Visibility follows the new location: inside a student's folder → that student sees it.
    const studentId = target?.studentId ?? null;
    const updated = await this.prisma.$transaction(async (tx) => {
      if (studentId !== folder.studentId) {
        await tx.libraryFolder.updateMany({ where: { id: { in: subtree } }, data: { studentId } });
      }
      return tx.libraryFolder.update({
        where: { id },
        data: { name: dto.name, color: dto.color, parentId: target?.id ?? null },
        include: folderInclude,
      });
    });
    return this.folderDto(updated, user);
  }

  async removeFolder(user: JwtUser, id: string) {
    const folder = await this.writableFolder(user, id);
    const all = await this.prisma.libraryFolder.findMany({ where: this.folderWhere(user, folder.scope), select: { id: true, parentId: true } });
    const subtree = descendantsOf(id, all);
    const files = await this.prisma.libraryFile.findMany({ where: { folderId: { in: subtree } }, select: { blobId: true } });
    await this.prisma.libraryFolder.delete({ where: { id } }); // cascades to sub-folders and files
    await this.releaseBlobs(files.map((f) => f.blobId));
  }

  // ───────────── Files ─────────────

  async listFiles(user: JwtUser, query: ListFilesQuery) {
    const scope = query.scope ?? 'PERSONAL';
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 48;
    const where: Prisma.LibraryFileWhereInput = { ...this.fileWhere(user, scope) };

    if (query.folderId === 'root') {
      if (user.role !== 'STUDENT') where.folderId = null;
    } else if (query.folderId) {
      await this.visibleFolder(user, query.folderId, scope);
      where.folderId = query.folderId;
    }
    if (query.q?.trim()) where.name = { contains: query.q.trim(), mode: 'insensitive' };
    if (query.category) where.category = query.category;
    if (query.starred) where.starred = true;

    const sort = query.sort ?? 'createdAt';
    const order = query.order ?? (sort === 'name' ? 'asc' : 'desc');
    const listWhere = query.kind ? { ...where, kind: query.kind } : where;

    const [rows, total, facets] = await Promise.all([
      this.prisma.libraryFile.findMany({
        where: listWhere,
        include: fileInclude,
        orderBy: [{ [sort]: order }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.libraryFile.count({ where: listWhere }),
      // Counts per type ignore the type filter itself, so the chips always show what's there.
      this.prisma.libraryFile.groupBy({ by: ['kind'], where, _count: { _all: true } }),
    ]);

    return {
      data: rows.map((r) => this.fileDto(r, user)),
      total,
      page,
      pageSize,
      facets: Object.fromEntries(facets.map((f) => [f.kind, f._count._all])),
    };
  }

  async upload(user: JwtUser, file: UploadedTempFile | undefined, dto: UploadFileDto) {
    if (!file) throw new BadRequestException(msg('library.noFile'));
    const scope = dto.scope ?? 'PERSONAL';
    const tenantId = user.tenantId!;
    let storageKey: string | null = null;
    let thumbnailKey: string | null = null;
    try {
      const name = cleanFileName(file.originalname);
      const type = detectType(name);
      if (!type) throw new BadRequestException(msg('library.unsupportedType'));
      if (file.size === 0) throw new BadRequestException(msg('library.emptyFile'));

      if (scope === 'SHARED') await this.quota.assertCanManageShared(user);
      const folder = dto.folderId ? await this.writableFolder(user, dto.folderId, scope) : null;
      // Center-library files are charged to the center; everything else to the uploader.
      const chargedToId = scope === 'SHARED' ? null : user.id;
      await this.quota.assertCanStore(tenantId, chargedToId, file.size);

      storageKey = this.storage.newKey(tenantId, type.extension);
      await this.storage.putFile(file.path, storageKey);
      thumbnailKey = type.kind === 'IMAGE' ? await this.makeThumbnail(tenantId, storageKey) : null;

      const key = storageKey;
      const created = await this.prisma.$transaction(async (tx) => {
        const blob = await tx.storedBlob.create({ data: { tenantId, key, thumbnailKey, size: file.size, chargedToId } });
        return tx.libraryFile.create({
          data: {
            tenantId,
            ownerId: user.id,
            scope,
            folderId: folder?.id ?? null,
            name,
            extension: type.extension,
            mimeType: type.mime,
            size: file.size,
            kind: type.kind,
            category: dto.category ?? (type.kind === 'EBOOK' ? 'BOOK' : 'OTHER'),
            blobId: blob.id,
          },
          include: fileInclude,
        });
      });
      storageKey = null; // owned by the database row now
      return this.fileDto(created, user);
    } finally {
      await rm(file.path, { force: true }).catch(() => undefined);
      // The row was never created: don't leave orphan bytes behind.
      if (storageKey) await this.storage.remove(storageKey);
      if (storageKey && thumbnailKey) await this.storage.remove(thumbnailKey);
    }
  }

  async updateFile(user: JwtUser, id: string, dto: UpdateFileDto) {
    const file = await this.writableFile(user, id);
    let folderId: string | null | undefined;
    if (dto.folderId !== undefined) folderId = dto.folderId ? (await this.writableFolder(user, dto.folderId, file.scope)).id : null;
    const updated = await this.prisma.libraryFile.update({
      where: { id },
      data: {
        name: dto.name ? cleanFileName(dto.name) : undefined,
        category: dto.category,
        description: dto.description,
        // Stars are personal; a center-library row is shared by everyone.
        starred: file.scope === 'PERSONAL' ? dto.starred : undefined,
        folderId,
      },
      include: fileInclude,
    });
    return this.fileDto(updated, user);
  }

  async moveFiles(user: JwtUser, dto: MoveFilesDto) {
    const { scope } = await this.writableFiles(user, dto.ids);
    const folderId = dto.folderId ? (await this.writableFolder(user, dto.folderId, scope)).id : null;
    const { count } = await this.prisma.libraryFile.updateMany({
      where: { id: { in: dto.ids }, ...this.fileWhere(user, scope) },
      data: { folderId },
    });
    return { moved: count };
  }

  async removeFiles(user: JwtUser, ids: string[]) {
    const { files, scope } = await this.writableFiles(user, ids);
    await this.prisma.libraryFile.deleteMany({ where: { id: { in: files.map((f) => f.id) }, ...this.fileWhere(user, scope) } });
    await this.releaseBlobs(files.map((f) => f.blobId));
    return { deleted: files.length };
  }

  /**
   * Puts a copy of each file in each student's folder. Works for the teacher's own files and
   * for center-library files. Copies share the stored blob (sending a 50 MB book to 30
   * students stores it once, charged where it already is). Already-sent files are skipped.
   */
  async sendToStudents(user: JwtUser, dto: SendFilesDto) {
    const files = await this.prisma.libraryFile.findMany({
      where: { id: { in: dto.ids }, tenantId: user.tenantId!, OR: [{ scope: 'PERSONAL', ownerId: user.id }, { scope: 'SHARED' }] },
    });
    if (files.length === 0) throw new NotFoundException(msg('library.filesNotFound'));
    const studentIds = [...new Set(dto.studentIds)];
    await this.accessibleStudents(user, studentIds);

    let sent = 0;
    let skipped = 0;
    for (const studentId of studentIds) {
      const root = await this.ensureStudentFolder(user, studentId);
      const already = await this.prisma.libraryFile.findMany({
        where: { ownerId: user.id, scope: 'PERSONAL', blobId: { in: files.map((f) => f.blobId) }, folder: { studentId } },
        select: { blobId: true },
      });
      const have = new Set(already.map((a) => a.blobId));
      const fresh = uniqueBy(files, (f) => f.blobId).filter((f) => !have.has(f.blobId));
      skipped += files.length - fresh.length;
      if (fresh.length === 0) continue;
      await this.prisma.libraryFile.createMany({ data: fresh.map((f) => copyOf(f, { ownerId: user.id, folderId: root.id })) });
      sent += fresh.length;
    }
    return { sent, skipped, students: studentIds.length };
  }

  /** Adds center-library files to the caller's personal library without using their quota. */
  async importShared(user: JwtUser, dto: ImportFilesDto) {
    const files = await this.prisma.libraryFile.findMany({
      where: { id: { in: dto.ids }, tenantId: user.tenantId!, scope: 'SHARED' },
    });
    if (files.length === 0) throw new NotFoundException(msg('library.filesNotFound'));
    const folder = dto.folderId ? await this.writableFolder(user, dto.folderId, 'PERSONAL') : null;

    // Skip what's already in the personal library (outside students' folders).
    const already = await this.prisma.libraryFile.findMany({
      where: {
        ownerId: user.id,
        scope: 'PERSONAL',
        blobId: { in: files.map((f) => f.blobId) },
        OR: [{ folderId: null }, { folder: { studentId: null } }],
      },
      select: { blobId: true },
    });
    const have = new Set(already.map((a) => a.blobId));
    const fresh = uniqueBy(files, (f) => f.blobId).filter((f) => !have.has(f.blobId));
    if (fresh.length) {
      await this.prisma.libraryFile.createMany({ data: fresh.map((f) => copyOf(f, { ownerId: user.id, folderId: folder?.id ?? null })) });
    }
    return { imported: fresh.length, skipped: files.length - fresh.length };
  }

  // ───────────── Signed blob access ─────────────

  readGrant(token: string): BlobGrant | null {
    return verifyBlobToken(token, this.urlSecret);
  }

  blobPath(key: string) {
    return this.storage.resolve(key);
  }

  private blobUrl(grant: Omit<BlobGrant, 'e'>) {
    const token = createBlobToken({ ...grant, e: bucketedExpiry(URL_TTL_HOURS) }, this.urlSecret);
    return `/library/blob/${token}`;
  }

  // ───────────── Blob lifecycle ─────────────

  /** Deletes the given blobs (bytes and rows) if no file row points at them any more. */
  async releaseBlobs(blobIds: string[]) {
    const ids = [...new Set(blobIds)];
    if (ids.length === 0) return;
    const orphans = await this.prisma.storedBlob.findMany({
      where: { id: { in: ids }, files: { none: {} } },
      select: { id: true, key: true, thumbnailKey: true },
    });
    if (orphans.length === 0) return;
    await this.prisma.storedBlob.deleteMany({ where: { id: { in: orphans.map((o) => o.id) }, files: { none: {} } } });
    for (const o of orphans) {
      await this.storage.remove(o.key);
      if (o.thumbnailKey) await this.storage.remove(o.thumbnailKey);
    }
  }

  /** Blobs left without files (e.g. after a user was deleted with their rows). */
  async releaseOrphans(tenantId: string) {
    const orphans = await this.prisma.storedBlob.findMany({ where: { tenantId, files: { none: {} } }, select: { id: true } });
    await this.releaseBlobs(orphans.map((o) => o.id));
  }

  // ───────────── DTO mapping ─────────────

  private fileDto(f: FileRow, user: JwtUser) {
    const inline = canRenderInline(f.kind, f.mimeType);
    const folder = f.folder
      ? {
          id: f.folder.id,
          // Students see their teacher's name instead of their own on their top folder.
          name: this.folderName({ ...f.folder, owner: f.owner }, user),
          studentId: f.folder.studentId,
          studentName: f.folder.student?.user.fullName ?? null,
        }
      : null;
    return {
      id: f.id,
      scope: f.scope,
      name: f.name,
      extension: f.extension,
      mimeType: f.mimeType,
      size: f.size,
      kind: f.kind,
      category: f.category,
      description: f.description,
      starred: user.role === 'STUDENT' || f.scope === 'SHARED' ? false : f.starred,
      folderId: f.folderId,
      folder,
      owner: f.owner,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      previewUrl: inline ? this.blobUrl({ k: f.blob.key, n: f.name, t: f.mimeType, d: 0 }) : null,
      thumbnailUrl: f.blob.thumbnailKey ? this.blobUrl({ k: f.blob.thumbnailKey, n: 'thumb.webp', t: 'image/webp', d: 0 }) : null,
      downloadUrl: this.blobUrl({ k: f.blob.key, n: f.name, t: f.mimeType, d: 1 }),
    };
  }

  private folderDto(f: Prisma.LibraryFolderGetPayload<{ include: typeof folderInclude }>, user: JwtUser) {
    return {
      id: f.id,
      scope: f.scope,
      name: this.folderName(f, user),
      parentId: f.parentId,
      studentId: f.studentId,
      studentName: f.student?.user.fullName ?? null,
      isStudentRoot: f.studentId !== null && f.parentId === null,
      color: f.color,
      owner: f.owner,
      files: f._count.files,
      folders: f._count.children,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    };
  }

  private folderName(
    f: { name: string; parentId: string | null; studentId: string | null; student?: { user: { fullName: string } } | null; owner: { fullName: string } },
    user: JwtUser,
  ) {
    if (f.studentId && f.parentId === null) {
      return user.role === 'STUDENT' ? f.owner.fullName : (f.student?.user.fullName ?? f.name);
    }
    return f.name;
  }

  // ───────────── Access helpers ─────────────

  private folderWhere(user: JwtUser, scope: LibraryScope): Prisma.LibraryFolderWhereInput {
    return scope === 'SHARED'
      ? { tenantId: user.tenantId!, scope: 'SHARED' }
      : { tenantId: user.tenantId!, scope: 'PERSONAL', ownerId: user.id };
  }

  /** Files the user may see in a scope; students only see what sits in their folders. */
  private fileWhere(user: JwtUser, scope: LibraryScope): Prisma.LibraryFileWhereInput {
    if (user.role === 'STUDENT') return { tenantId: user.tenantId!, folder: { studentId: user.studentId! } };
    return scope === 'SHARED'
      ? { tenantId: user.tenantId!, scope: 'SHARED' }
      : { tenantId: user.tenantId!, scope: 'PERSONAL', ownerId: user.id };
  }

  private studentScope(user: JwtUser): Prisma.StudentWhereInput {
    return user.role === 'TEACHER'
      ? { tenantId: user.tenantId!, teachers: { some: { teacherId: user.teacherId! } } }
      : { tenantId: user.tenantId! };
  }

  private async accessibleStudents(user: JwtUser, ids: string[]) {
    const students = await this.prisma.student.findMany({
      where: { ...this.studentScope(user), id: { in: ids } },
      select: { id: true, user: { select: { fullName: true } } },
    });
    if (students.length !== ids.length) throw new ForbiddenException(msg('library.studentsNotLinked'));
    return students;
  }

  /** A folder the user may change: their own personal folder, or a center folder if they manage it. */
  private async writableFolder(user: JwtUser, id: string, scope?: LibraryScope) {
    const folder = await this.prisma.libraryFolder.findFirst({ where: { id, tenantId: user.tenantId! } });
    const ok = folder && (!scope || folder.scope === scope) && (folder.scope === 'SHARED' || folder.ownerId === user.id);
    if (!folder || !ok) throw new NotFoundException(msg('library.folderNotFound'));
    if (folder.scope === 'SHARED') await this.quota.assertCanManageShared(user);
    return folder;
  }

  private async visibleFolder(user: JwtUser, id: string, scope: LibraryScope) {
    const folder = await this.prisma.libraryFolder.findFirst({ where: { id, tenantId: user.tenantId! } });
    const allowed =
      user.role === 'STUDENT'
        ? folder?.studentId === user.studentId
        : folder?.scope === scope && (scope === 'SHARED' || folder.ownerId === user.id);
    if (!folder || !allowed) throw new NotFoundException(msg('library.folderNotFound'));
    return folder;
  }

  private async writableFile(user: JwtUser, id: string) {
    const file = await this.prisma.libraryFile.findFirst({ where: { id, tenantId: user.tenantId! } });
    if (!file || (file.scope === 'PERSONAL' && file.ownerId !== user.id)) throw new NotFoundException(msg('library.fileNotFound'));
    if (file.scope === 'SHARED') await this.quota.assertCanManageShared(user);
    return file;
  }

  /** Files the user may change; all of them must be in one library. */
  private async writableFiles(user: JwtUser, ids: string[]) {
    const files = await this.prisma.libraryFile.findMany({
      where: { id: { in: ids }, tenantId: user.tenantId!, OR: [{ scope: 'PERSONAL', ownerId: user.id }, { scope: 'SHARED' }] },
      select: { id: true, blobId: true, scope: true },
    });
    if (files.length === 0) throw new NotFoundException(msg('library.fileNotFound'));
    const scopes = new Set(files.map((f) => f.scope));
    if (scopes.size > 1) throw new BadRequestException(msg('library.mixedScopes'));
    const scope = files[0].scope;
    if (scope === 'SHARED') await this.quota.assertCanManageShared(user);
    return { files, scope };
  }

  /** 1 for a top-level folder, 2 for its child, … */
  private async depthOf(user: JwtUser, scope: LibraryScope, id: string) {
    const all = await this.prisma.libraryFolder.findMany({ where: this.folderWhere(user, scope), select: { id: true, parentId: true } });
    const parentOf = new Map(all.map((f) => [f.id, f.parentId]));
    let depth = 0;
    for (let cur: string | null | undefined = id; cur && depth <= MAX_FOLDER_DEPTH + 1; cur = parentOf.get(cur)) depth++;
    return depth;
  }

  private async makeThumbnail(tenantId: string, storageKey: string) {
    try {
      const { default: sharp } = await import('sharp');
      const data = await sharp(this.storage.resolve(storageKey), { animated: false })
        .rotate()
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 76 })
        .toBuffer();
      const key = this.storage.newKey(tenantId, 'webp', 'thumbs');
      await this.storage.putBuffer(data, key);
      return key;
    } catch (err) {
      this.logger.warn(`Thumbnail failed for ${storageKey}: ${String(err)}`);
      return null;
    }
  }
}

type CopySource = Prisma.LibraryFileGetPayload<object>;

/** A personal row pointing at the same blob (send to a student / import from the center library). */
function copyOf(f: CopySource, to: { ownerId: string; folderId: string | null }): Prisma.LibraryFileCreateManyInput {
  return {
    tenantId: f.tenantId,
    ownerId: to.ownerId,
    scope: 'PERSONAL',
    folderId: to.folderId,
    name: f.name,
    extension: f.extension,
    mimeType: f.mimeType,
    size: f.size,
    kind: f.kind,
    category: f.category,
    description: f.description,
    blobId: f.blobId,
  };
}

function uniqueBy<T>(items: T[], key: (t: T) => string) {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(key(i)) ? false : (seen.add(key(i)), true)));
}

/** `id` and every folder beneath it. */
export function descendantsOf(id: string, folders: { id: string; parentId: string | null }[]) {
  const children = new Map<string, string[]>();
  for (const f of folders) {
    if (!f.parentId) continue;
    children.set(f.parentId, [...(children.get(f.parentId) ?? []), f.id]);
  }
  const out: string[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    out.push(cur);
    stack.push(...(children.get(cur) ?? []));
  }
  return out;
}

/** Levels in the subtree rooted at `id` (1 = no sub-folders). */
function subtreeHeight(id: string, folders: { id: string; parentId: string | null }[]): number {
  const kids = folders.filter((f) => f.parentId === id);
  return 1 + (kids.length ? Math.max(...kids.map((k) => subtreeHeight(k.id, folders))) : 0);
}
