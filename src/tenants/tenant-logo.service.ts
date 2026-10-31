import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../library/storage.service.js';
import { bucketedExpiry, createBlobToken } from '../library/signed-url.js';
import { msg } from '../i18n/i18n.js';

export const LOGO_MAX_MB = 2;
const LOGO_SIZE = 512;
const URL_TTL_HOURS = 24;
const FORMATS = ['png', 'jpeg', 'webp'];

export type UploadedLogo = { buffer: Buffer; size: number };

/**
 * The center's logo, printed on its reports. Uploads are re-encoded to a PNG of at most
 * 512×512 (no SVG, so nothing scriptable is ever stored), and browsers read it through the
 * library's signed blob links.
 */
@Injectable()
export class TenantLogoService {
  private readonly urlSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.urlSecret = config.get<string>('FILES_URL_SECRET') || config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  /** A short-lived link to the logo, or null when the center has none. */
  url(logoKey: string | null) {
    if (!logoKey) return null;
    const token = createBlobToken({ k: logoKey, n: 'logo.png', t: 'image/png', d: 0, e: bucketedExpiry(URL_TTL_HOURS) }, this.urlSecret);
    return `/library/blob/${token}`;
  }

  async set(tenantId: string, file: UploadedLogo | undefined) {
    if (!file) throw new BadRequestException(msg('tenants.logoInvalid'));
    if (file.size > LOGO_MAX_MB * 1024 * 1024) throw new PayloadTooLargeException(msg('tenants.logoTooLarge', { mb: LOGO_MAX_MB }));

    const { default: sharp } = await import('sharp');
    let png: Buffer;
    try {
      const meta = await sharp(file.buffer).metadata();
      if (!FORMATS.includes(meta.format ?? '')) throw new Error(`format ${meta.format}`);
      png = await sharp(file.buffer, { animated: false })
        .rotate()
        .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
    } catch {
      throw new BadRequestException(msg('tenants.logoInvalid'));
    }

    const key = this.storage.newKey(tenantId, 'png', 'brand');
    await this.storage.putBuffer(png, key);
    const before = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { logoKey: true } });
    await this.prisma.tenant.update({ where: { id: tenantId }, data: { logoKey: key } });
    if (before.logoKey) await this.storage.remove(before.logoKey);
  }

  async remove(tenantId: string) {
    const before = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { logoKey: true } });
    if (!before.logoKey) return;
    await this.prisma.tenant.update({ where: { id: tenantId }, data: { logoKey: null } });
    await this.storage.remove(before.logoKey);
  }
}
