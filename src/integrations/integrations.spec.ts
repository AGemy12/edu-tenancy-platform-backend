import { createHmac } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { vi } from 'vitest';
import { deriveKey, openSecret, sealSecret } from './token-cipher.js';
import { urlValidationResponse, verifyZoomSignature, zoomSignature } from './zoom-signature.js';
import { canLinkMeetingAccount, linkedAccounts } from './meeting-accounts.js';
import { IntegrationsController } from './integrations.controller.js';
import type { JwtUser } from '../common/decorators/current-user.decorator.js';

describe('meeting accounts', () => {
  it('are linked only by members who teach in the center', () => {
    expect(canLinkMeetingAccount({ teacherId: 'tc1' })).toBe(true);
    expect(canLinkMeetingAccount({ teacherId: null })).toBe(false);
  });

  it('maps integration rows to what each session provider needs', () => {
    expect(linkedAccounts([])).toEqual({ zoom: false, google: false });
    expect(linkedAccounts(['ZOOM'])).toEqual({ zoom: true, google: false });
    expect(linkedAccounts(['GOOGLE', 'ZOOM'])).toEqual({ zoom: true, google: true });
  });

  const base: JwtUser = {
    id: 'u1', email: 'owner@x.test', role: 'TENANT_ADMIN', tenantId: 't1', teacherId: null, studentId: null, status: 'ACTIVE', membershipId: 'm1',
  };
  function controller() {
    const integrations = { googleAuthUrl: vi.fn().mockResolvedValue({ url: 'g' }), status: vi.fn() };
    const zoom = { authUrl: vi.fn().mockResolvedValue({ url: 'z' }), disconnect: vi.fn() };
    return { integrations, zoom, ctrl: new IntegrationsController(integrations as never, zoom as never, {} as never) };
  }

  it('an admin who does not teach cannot start linking, but may still disconnect', async () => {
    const { integrations, zoom, ctrl } = controller();
    expect(() => ctrl.zoomConnect(base)).toThrow(ForbiddenException);
    expect(() => ctrl.googleConnect(base)).toThrow(ForbiddenException);
    expect(zoom.authUrl).not.toHaveBeenCalled();
    expect(integrations.googleAuthUrl).not.toHaveBeenCalled();
    await ctrl.disconnectZoom(base);
    expect(zoom.disconnect).toHaveBeenCalledWith('u1');
  });

  it('a teacher, or an admin with a teacher profile, can', async () => {
    for (const user of [{ ...base, teacherId: 'tc1' }, { ...base, role: 'TEACHER' as const, teacherId: 'tc2' }]) {
      const { ctrl } = controller();
      await expect(ctrl.zoomConnect(user)).resolves.toEqual({ url: 'z' });
      await expect(ctrl.googleConnect(user)).resolves.toEqual({ url: 'g' });
    }
  });
});

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
