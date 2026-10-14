import { createHmac, timingSafeEqual } from 'node:crypto';

/** Zoom rejects nothing older than this; neither do we (limits replays). */
const MAX_SKEW_MS = 5 * 60_000;

/** `v0=` + HMAC-SHA256(secret, `v0:{timestamp}:{raw body}`), as Zoom signs webhook requests. */
export function zoomSignature(secret: string, timestamp: string, rawBody: string | Buffer) {
  const hmac = createHmac('sha256', secret).update(`v0:${timestamp}:`).update(rawBody).digest('hex');
  return `v0=${hmac}`;
}

/**
 * Checks `x-zm-signature` / `x-zm-request-timestamp` on a webhook request.
 * Docs: https://developers.zoom.us/docs/api/webhooks/#verify-webhook-events
 */
export function verifyZoomSignature(
  secret: string,
  headers: { timestamp?: string; signature?: string },
  rawBody: string | Buffer,
  now = Date.now(),
): boolean {
  const { timestamp, signature } = headers;
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > MAX_SKEW_MS) return false;
  const expected = Buffer.from(zoomSignature(secret, timestamp, rawBody));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Answer to Zoom's `endpoint.url_validation` challenge. */
export function urlValidationResponse(secret: string, plainToken: string) {
  return { plainToken, encryptedToken: createHmac('sha256', secret).update(plainToken).digest('hex') };
}
