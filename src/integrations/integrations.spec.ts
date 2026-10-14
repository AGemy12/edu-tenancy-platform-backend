import { createHmac } from 'node:crypto';
import { deriveKey, openSecret, sealSecret } from './token-cipher.js';
import { urlValidationResponse, verifyZoomSignature, zoomSignature } from './zoom-signature.js';

describe('token cipher', () => {
  const key = deriveKey('test-secret');

  it('round-trips and never stores the plain token', () => {
    const sealed = sealSecret('ya29.token', key);
    expect(sealed.startsWith('enc:v1:')).toBe(true);
    expect(sealed).not.toContain('ya29');
    expect(openSecret(sealed, key)).toBe('ya29.token');
    expect(sealSecret('ya29.token', key)).not.toBe(sealed); // random IV
  });

  it('reads tokens stored before encryption', () => {
    expect(openSecret('legacy-plain-token', key)).toBe('legacy-plain-token');
  });

  it('rejects a wrong key or tampered data', () => {
    const sealed = sealSecret('secret', key);
    expect(() => openSecret(sealed, deriveKey('other'))).toThrow();
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    expect(() => openSecret(tampered, key)).toThrow();
  });
});

describe('zoom webhook signature', () => {
  const secret = 'zoom-secret';
  const body = '{"event":"meeting.started","payload":{"object":{"id":123}}}';
  const now = 1_790_000_000_000;
  const ts = String(now / 1000);

  it('matches the documented formula', () => {
    const expected = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
    expect(zoomSignature(secret, ts, body)).toBe(expected);
  });

  it('accepts a valid request', () => {
    const signature = zoomSignature(secret, ts, body);
    expect(verifyZoomSignature(secret, { timestamp: ts, signature }, Buffer.from(body), now)).toBe(true);
  });

  it('rejects forged, altered, stale and incomplete requests', () => {
    const signature = zoomSignature(secret, ts, body);
    expect(verifyZoomSignature('other', { timestamp: ts, signature }, body, now)).toBe(false);
    expect(verifyZoomSignature(secret, { timestamp: ts, signature }, body.replace('123', '124'), now)).toBe(false);
    expect(verifyZoomSignature(secret, { timestamp: ts, signature }, body, now + 6 * 60_000)).toBe(false);
    expect(verifyZoomSignature(secret, { timestamp: ts }, body, now)).toBe(false);
    expect(verifyZoomSignature(secret, { timestamp: 'abc', signature }, body, now)).toBe(false);
  });

  it('answers the URL validation challenge', () => {
    expect(urlValidationResponse(secret, 'plain')).toEqual({
      plainToken: 'plain',
      encryptedToken: createHmac('sha256', secret).update('plain').digest('hex'),
    });
  });
});
