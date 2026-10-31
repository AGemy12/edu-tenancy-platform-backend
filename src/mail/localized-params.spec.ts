import { localizedParams } from './mail.service.js';

describe('localizedParams', () => {
  it("writes moments in the center's time zone and calendar days as such", () => {
    const en = localizedParams({ at: '2026-10-23T19:00:00.000Z', from: '2026-11-01' }, 'en', 'Africa/Cairo');
    // 19:00 UTC is 22:00 in Cairo (summer time, UTC+3, until the end of October).
    expect(String(en.at)).toContain('10:00 PM');
    expect(String(en.at)).toContain('October 23, 2026');
    expect(en.from).toBe('November 1, 2026');
  });

  it('picks the reader’s language from xAr/xEn pairs', () => {
    expect(localizedParams({ planAr: 'الباقة', planEn: 'Pro' }, 'en', 'UTC')).toEqual({ plan: '⁨Pro⁩' });
    expect(localizedParams({ planAr: 'الباقة', planEn: 'Pro' }, 'ar', 'UTC').plan).toBe('⁨الباقة⁩');
  });

  it('isolates names so they keep their direction, and leaves numbers alone', () => {
    expect(localizedParams({ teacher: 'محمد', count: 3 }, 'en', 'UTC')).toEqual({ teacher: '⁨محمد⁩', count: 3 });
  });
});
