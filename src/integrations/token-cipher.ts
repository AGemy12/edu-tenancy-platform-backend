import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const PREFIX = 'enc:v1:';

/** AES-256-GCM. The output is `enc:v1:` + base64url(iv | tag | ciphertext). */
export function sealSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** Reverses `sealSecret`. Values stored before encryption existed are returned as they are. */
export function openSecret(stored: string, key: Buffer): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export const deriveKey = (secret: string) => createHash('sha256').update(secret).digest();

/** Encrypts provider OAuth tokens at rest (`Integration.accessToken` / `refreshToken`). */
@Injectable()
export class TokenCipher {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.key = deriveKey(config.get<string>('INTEGRATIONS_SECRET') || config.getOrThrow<string>('JWT_ACCESS_SECRET'));
  }

  seal(plain: string): string;
  seal(plain: string | null | undefined): string | null | undefined;
  seal(plain: string | null | undefined) {
    return plain == null ? plain : sealSecret(plain, this.key);
  }

  open(stored: string): string;
  open(stored: string | null): string | null;
  open(stored: string | null) {
    return stored == null ? null : openSecret(stored, this.key);
  }
}
