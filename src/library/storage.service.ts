import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Blob storage on the local disk (STORAGE_DIR). Everything outside this class only deals
 * in opaque keys, so swapping in S3 / R2 / MinIO means re-implementing these few methods
 * (and redirecting /library/blob to a presigned URL).
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = path.resolve(config.get<string>('STORAGE_DIR') ?? 'storage');
  }

  newKey(tenantId: string, extension: string, folder = 'files') {
    const month = new Date().toISOString().slice(0, 7);
    return `${tenantId}/${folder}/${month}/${randomUUID()}${extension ? `.${extension}` : ''}`;
  }

  /** Moves an uploaded temp file into storage. */
  async putFile(tempPath: string, key: string) {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await rename(tempPath, target);
    } catch {
      // Temp dir on another drive: rename can't cross devices.
      await copyFile(tempPath, target);
      await rm(tempPath, { force: true });
    }
  }

  async putBuffer(data: Buffer, key: string) {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  async remove(key: string) {
    try {
      await rm(this.resolve(key), { force: true });
    } catch (err) {
      this.logger.warn(`Could not delete ${key}: ${String(err)}`);
    }
  }

  /** Absolute path of a key; refuses keys that escape the storage root. */
  resolve(key: string) {
    const target = path.resolve(this.root, key);
    if (!target.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return target;
  }
}
