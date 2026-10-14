import { createHmac, timingSafeEqual } from 'node:crypto';

/** What a signed file URL grants: read one stored object, with these response headers, until `exp`. */
export type BlobGrant = {
  /** storage key */
  k: string;
  /** file name for Content-Disposition */
  n: string;
  /** Content-Type */
  t: string;
  /** 1 = attachment (download), 0 = inline (preview) */
  d: 0 | 1;
  /** expiry, unix seconds */
  e: number;
};

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

function sign(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest();
}

/**
 * Stateless signed token, the same idea as an S3 presigned URL: <img>, <video> and
 * <iframe> can't send a bearer header, so the API hands out short-lived links instead.
 */
export function createBlobToken(grant: BlobGrant, secret: string): string {
  const payload = b64(JSON.stringify(grant));
  return `${payload}.${b64(sign(payload, secret))}`;
}

export function verifyBlobToken(token: string, secret: string, now = Date.now()): BlobGrant | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload, secret);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as BlobGrant;
    return grant.e * 1000 > now ? grant : null;
  } catch {
    return null;
  }
}

/**
 * Expiry rounded up to the hour so the same file gets the same URL across refetches
 * and the browser can cache thumbnails.
 */
export function bucketedExpiry(ttlHours: number, now = Date.now()) {
  const hour = 3600;
  return (Math.ceil(now / 1000 / hour) + ttlHours) * hour;
}
