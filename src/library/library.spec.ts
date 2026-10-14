import { canRenderInline, cleanFileName, detectType } from './file-types.js';
import { bucketedExpiry, createBlobToken, verifyBlobToken } from './signed-url.js';
import { descendantsOf } from './library.service.js';

describe('file types', () => {
  it('detects kind and mime from the extension, case-insensitively', () => {
    expect(detectType('كتاب الفيزياء.PDF')).toEqual({ extension: 'pdf', mime: 'application/pdf', kind: 'PDF' });
    expect(detectType('photo.jpeg')?.kind).toBe('IMAGE');
    expect(detectType('book.epub')?.kind).toBe('EBOOK');
  });

  it('rejects unknown and dangerous types', () => {
    expect(detectType('page.html')).toBeNull();
    expect(detectType('icon.svg')).toBeNull();
    expect(detectType('noextension')).toBeNull();
  });

  it('only renders media, pdf and plain text inline', () => {
    expect(canRenderInline('PDF', 'application/pdf')).toBe(true);
    expect(canRenderInline('DOCUMENT', 'application/msword')).toBe(false);
  });

  it('strips paths and control characters from names', () => {
    expect(cleanFileName('C:\\fakepath\\../ملخص\u0007.pdf')).toBe('ملخص.pdf');
    expect(cleanFileName('   ')).toBe('file');
  });
});

describe('signed blob tokens', () => {
  const secret = 'test-secret';
  const grant = { k: 't1/files/a.pdf', n: 'ملف.pdf', t: 'application/pdf', d: 0 as const, e: 2_000_000_000 };

  it('round-trips a valid token', () => {
    expect(verifyBlobToken(createBlobToken(grant, secret), secret, 0)).toEqual(grant);
  });

  it('rejects tampered, foreign and expired tokens', () => {
    const token = createBlobToken(grant, secret);
    const [, sig] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ ...grant, k: 't2/files/b.pdf' })).toString('base64url')}.${sig}`;
    expect(verifyBlobToken(forged, secret, 0)).toBeNull();
    expect(verifyBlobToken(token, 'other-secret', 0)).toBeNull();
    expect(verifyBlobToken(token, secret, grant.e * 1000 + 1)).toBeNull();
    expect(verifyBlobToken('garbage', secret, 0)).toBeNull();
  });

  it('keeps the same expiry within an hour so URLs stay cacheable', () => {
    const base = Date.UTC(2026, 0, 1, 10, 0, 1);
    expect(bucketedExpiry(6, base)).toBe(bucketedExpiry(6, base + 50 * 60_000));
  });
});

describe('descendantsOf', () => {
  it('returns the folder and everything under it', () => {
    const folders = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
      { id: 'c', parentId: 'b' },
      { id: 'd', parentId: null },
    ];
    expect(descendantsOf('a', folders).sort()).toEqual(['a', 'b', 'c']);
    expect(descendantsOf('d', folders)).toEqual(['d']);
  });
});
