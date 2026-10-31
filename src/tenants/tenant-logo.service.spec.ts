import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { TenantLogoService } from './tenant-logo.service.js';
import { verifyBlobToken } from '../library/signed-url.js';

const config = { get: (k: string) => (k === 'FILES_URL_SECRET' ? 'test-secret' : undefined), getOrThrow: () => 'jwt' };

function setup(logoKey: string | null = null) {
  const prisma = {
    tenant: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ logoKey }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const storage = {
    newKey: vi.fn().mockReturnValue('t1/brand/2026-10/new.png'),
    putBuffer: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const service = new TenantLogoService(prisma as never, storage as never, config as never);
  return { service, prisma, storage };
}

const image = (format: 'png' | 'jpeg' | 'gif', size = 900) =>
  sharp({ create: { width: size, height: size / 2, channels: 3, background: '#4338ca' } })
    .toFormat(format)
    .toBuffer();

describe('TenantLogoService', () => {
  it('signs a link to the logo, and none without one', () => {
    const { service } = setup();
    expect(service.url(null)).toBeNull();
    const url = service.url('t1/brand/x.png')!;
    const grant = verifyBlobToken(url.replace('/library/blob/', ''), 'test-secret');
    expect(grant).toMatchObject({ k: 't1/brand/x.png', t: 'image/png', d: 0 });
  });

  it('stores a PNG no larger than 512px and drops the previous logo', async () => {
    const { service, prisma, storage } = setup('t1/brand/old.png');
    const buffer = await image('jpeg');
    await service.set('t1', { buffer, size: buffer.length });

    const stored = storage.putBuffer.mock.calls[0][0] as Buffer;
    const meta = await sharp(stored).metadata();
    expect(meta).toMatchObject({ format: 'png', width: 512, height: 256 });
    expect(prisma.tenant.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { logoKey: 't1/brand/2026-10/new.png' } });
    expect(storage.remove).toHaveBeenCalledWith('t1/brand/old.png');
  });

  it('refuses other formats, broken files and big uploads', async () => {
    const { service, storage } = setup();
    const gif = await image('gif', 100);
    await expect(service.set('t1', { buffer: gif, size: gif.length })).rejects.toMatchObject({ response: { i18n: 'tenants.logoInvalid' } });
    await expect(service.set('t1', { buffer: Buffer.from('<svg/>'), size: 6 })).rejects.toMatchObject({ response: { i18n: 'tenants.logoInvalid' } });
    await expect(service.set('t1', { buffer: Buffer.alloc(1), size: 3 * 1024 * 1024 })).rejects.toMatchObject({ response: { i18n: 'tenants.logoTooLarge' } });
    await expect(service.set('t1', undefined)).rejects.toMatchObject({ response: { i18n: 'tenants.logoInvalid' } });
    expect(storage.putBuffer).not.toHaveBeenCalled();
  });

  it('removes the logo and its file', async () => {
    const { service, prisma, storage } = setup('t1/brand/old.png');
    await service.remove('t1');
    expect(prisma.tenant.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { logoKey: null } });
    expect(storage.remove).toHaveBeenCalledWith('t1/brand/old.png');
  });
});
