import { CATEGORIES, NOTIFICATION_TYPES, OVERSIGHT_TYPES, categoryOf, channelsFor, effectivePreference, emailTemplates, preferencesFor, templateOf } from './notification-catalog.js';
import { isMessageKey, translate } from '../i18n/i18n.js';

describe('channelsFor', () => {
  it('uses the category defaults until the person chooses', () => {
    expect(channelsFor('SESSION_CANCELED')).toEqual({ inApp: true, email: true });
    expect(channelsFor('FILES_SHARED')).toEqual({ inApp: true, email: false });
  });

  it('never emails a type that is in-app only, whatever the preference', () => {
    expect(channelsFor('SESSION_LIVE', { inApp: true, email: true })).toEqual({ inApp: true, email: false });
    expect(channelsFor('SUPPORT_REQUESTED', { inApp: true, email: true }).email).toBe(false);
  });

  it('follows a saved choice', () => {
    expect(channelsFor('SESSION_REMINDER', { inApp: false, email: false })).toEqual({ inApp: false, email: false });
    expect(channelsFor('FILES_SHARED', { inApp: true, email: true })).toEqual({ inApp: true, email: true });
  });

  it('keeps locked categories in-app even when switched off', () => {
    expect(channelsFor('ACCOUNT_STATUS', { inApp: false, email: false })).toEqual({ inApp: true, email: false });
    expect(effectivePreference('ANNOUNCEMENTS', { inApp: false, email: true })).toEqual({ inApp: true, email: true });
  });
});

describe("center activity (the owner's copy)", () => {
  it('files every oversight copy under ACTIVITY, in-app only', () => {
    expect(categoryOf('SESSION_CANCELED', true)).toBe('ACTIVITY');
    expect(categoryOf('SESSION_CANCELED')).toBe('SESSIONS');
    expect(channelsFor('SESSION_CANCELED', { inApp: true, email: true }, true)).toEqual({ inApp: true, email: false });
  });

  it("can be muted on its own, without touching the admin's own session notices", () => {
    expect(channelsFor('SESSION_CANCELED', { inApp: false, email: false }, true).inApp).toBe(false);
    expect(channelsFor('SESSION_CANCELED', null).inApp).toBe(true);
  });

  it('is offered to center admins only, without an email switch', () => {
    expect(preferencesFor('TENANT_ADMIN', []).find((p) => p.category === 'ACTIVITY')).toEqual({ category: 'ACTIVITY', inApp: true, email: false, locked: false, emailAvailable: false });
    expect(preferencesFor('TEACHER', []).map((p) => p.category)).not.toContain('ACTIVITY');
  });

  it('covers every event that happens to someone in the center', () => {
    expect(OVERSIGHT_TYPES).toEqual(expect.arrayContaining(['SESSION_SCHEDULED', 'SESSION_CANCELED', 'EXAM_GRADED', 'ACCOUNT_STATUS', 'MEMBER_ADDED']));
    expect(OVERSIGHT_TYPES).not.toContain('SESSION_REMINDER');
  });
});

describe('preferencesFor', () => {
  it('lists only the categories a role can receive, in order', () => {
    expect(preferencesFor('STUDENT', []).map((p) => p.category)).toEqual(['SESSIONS', 'EXAMS', 'LIBRARY', 'PEOPLE', 'ACCOUNT', 'ANNOUNCEMENTS']);
    expect(preferencesFor('SUPER_ADMIN', []).map((p) => p.category)).toEqual(['SUPPORT', 'PLATFORM']);
    expect(preferencesFor('TENANT_ADMIN', []).map((p) => p.category)).toContain('SUBSCRIPTION');
    expect(preferencesFor('TEACHER', []).map((p) => p.category)).not.toContain('SUBSCRIPTION');
  });

  it('merges saved rows, and says when a category has nothing to email', () => {
    const prefs = preferencesFor('SUPER_ADMIN', [{ category: 'SUPPORT', inApp: false, email: false }]);
    expect(prefs).toEqual([
      { category: 'SUPPORT', inApp: true, email: false, locked: true, emailAvailable: true },
      { category: 'PLATFORM', inApp: true, email: false, locked: false, emailAvailable: false },
    ]);
  });
});

describe('catalog', () => {
  it('gives every type a category somebody can receive', () => {
    for (const spec of Object.values(NOTIFICATION_TYPES)) expect(CATEGORIES[spec.category].roles.length).toBeGreaterThan(0);
  });

  it('has email text for every template that can be emailed, in both languages', () => {
    for (const template of emailTemplates()) {
      for (const part of ['title', 'body']) {
        const key = `notify.${template}.${part}`;
        expect(isMessageKey(key), key).toBe(true);
        expect(translate('en', key as never)).not.toBe(key);
      }
    }
  });

  it('builds variant template keys', () => {
    expect(templateOf('ACCOUNT_STATUS', { variant: 'SUSPENDED' })).toBe('ACCOUNT_STATUS.SUSPENDED');
    expect(templateOf('EXAM_GRADED', { title: 'x' })).toBe('EXAM_GRADED');
  });
});
