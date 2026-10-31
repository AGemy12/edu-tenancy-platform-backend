import type { NotificationCategory, NotificationType, Role } from '../generated/prisma/enums.js';

/**
 * What each notification type is and how it may travel. Pure data and rules (unit-tested): the
 * service reads this to pick channels, the API to list preferences.
 *
 * - `email`: the type may be emailed at all. Time-critical types (a session going live) and types
 *   with their own email (a support request) are in-app only.
 */
export const NOTIFICATION_TYPES: Record<NotificationType, { category: NotificationCategory; email: boolean }> = {
  SESSION_SCHEDULED: { category: 'SESSIONS', email: true },
  SESSION_RESCHEDULED: { category: 'SESSIONS', email: true },
  SESSION_CANCELED: { category: 'SESSIONS', email: true },
  SESSION_LIVE: { category: 'SESSIONS', email: false },
  SESSION_REMINDER: { category: 'SESSIONS', email: true },
  SESSION_EVALUATED: { category: 'SESSIONS', email: false },
  SCHEDULE_CREATED: { category: 'SESSIONS', email: true },
  EXAM_PUBLISHED: { category: 'EXAMS', email: true },
  EXAM_GRADED: { category: 'EXAMS', email: true },
  FILES_SHARED: { category: 'LIBRARY', email: true },
  TEACHER_ASSIGNED: { category: 'PEOPLE', email: false },
  STUDENT_ASSIGNED: { category: 'PEOPLE', email: false },
  ACCOUNT_STATUS: { category: 'ACCOUNT', email: true },
  SUBSCRIPTION_CHANGED: { category: 'SUBSCRIPTION', email: true },
  SUBSCRIPTION_EXPIRING: { category: 'SUBSCRIPTION', email: true },
  SUBSCRIPTION_EXPIRED: { category: 'SUBSCRIPTION', email: true },
  SUPPORT_REQUESTED: { category: 'SUPPORT', email: false },
  SUPPORT_DECIDED: { category: 'SUPPORT', email: true },
  TENANT_REGISTERED: { category: 'PLATFORM', email: false },
  ANNOUNCEMENT: { category: 'ANNOUNCEMENTS', email: true },
  MEMBER_ADDED: { category: 'PEOPLE', email: false },
  MEETING_ACCOUNT_NEEDED: { category: 'SESSIONS', email: true },
};

type CategorySpec = {
  /** Who can receive it (the preferences screen shows only these). */
  roles: readonly Role[];
  inApp: boolean;
  email: boolean;
  /** In-app can't be turned off: the person must see it (their account, their center's access). */
  locked?: boolean;
};

const CENTER: readonly Role[] = ['TENANT_ADMIN', 'TEACHER', 'STUDENT'];

/** Defaults per category, used until a person saves their own choice. */
export const CATEGORIES: Record<NotificationCategory, CategorySpec> = {
  SESSIONS: { roles: CENTER, inApp: true, email: true },
  EXAMS: { roles: ['STUDENT'], inApp: true, email: true },
  LIBRARY: { roles: ['STUDENT'], inApp: true, email: false },
  PEOPLE: { roles: CENTER, inApp: true, email: false },
  ACCOUNT: { roles: CENTER, inApp: true, email: true, locked: true },
  SUBSCRIPTION: { roles: ['TENANT_ADMIN'], inApp: true, email: true, locked: true },
  SUPPORT: { roles: ['TENANT_ADMIN', 'SUPER_ADMIN'], inApp: true, email: true, locked: true },
  PLATFORM: { roles: ['SUPER_ADMIN'], inApp: true, email: false },
  ANNOUNCEMENTS: { roles: CENTER, inApp: true, email: true, locked: true },
  /** The admins' copy of what happens in their center (oversight rows): in-app, mutable on its own. */
  ACTIVITY: { roles: ['TENANT_ADMIN'], inApp: true, email: false },
};

export const CATEGORY_ORDER = Object.keys(CATEGORIES) as NotificationCategory[];

export type Channels = { inApp: boolean; email: boolean };
export type SavedPreference = { category: NotificationCategory } & Channels;

/** An oversight copy (a center admin told what happened to others) is center activity, whatever its type. */
export function categoryOf(type: NotificationType, oversight = false): NotificationCategory {
  return oversight ? 'ACTIVITY' : NOTIFICATION_TYPES[type].category;
}

/** The person's choice for a category, or its defaults; a locked category stays in-app. */
export function effectivePreference(category: NotificationCategory, saved?: Channels | null): Channels {
  const spec = CATEGORIES[category];
  const chosen = saved ?? spec;
  return { inApp: spec.locked ? true : chosen.inApp, email: chosen.email };
}

/** Where one notification of `type` goes for a person with these saved preferences. */
export function channelsFor(type: NotificationType, saved?: Channels | null, oversight = false): Channels {
  const pref = effectivePreference(categoryOf(type, oversight), saved);
  // Center activity is in-app only: an email per session booked would bury the owner's inbox.
  return { inApp: pref.inApp, email: !oversight && pref.email && NOTIFICATION_TYPES[type].email };
}

/** Events a center's admins also hear about when they happened to others (see NotificationEvents.oversee). */
export const OVERSIGHT_TYPES: readonly NotificationType[] = [
  'SESSION_SCHEDULED',
  'SESSION_RESCHEDULED',
  'SESSION_CANCELED',
  'SESSION_LIVE',
  'SESSION_EVALUATED',
  'SCHEDULE_CREATED',
  'EXAM_PUBLISHED',
  'EXAM_GRADED',
  'FILES_SHARED',
  'TEACHER_ASSIGNED',
  'ACCOUNT_STATUS',
  'MEMBER_ADDED',
];

/** The preferences screen for one role: its categories in order, with what is in effect. */
export function preferencesFor(role: Role, saved: SavedPreference[]) {
  const byCategory = new Map(saved.map((p) => [p.category, p]));
  return CATEGORY_ORDER.filter((c) => CATEGORIES[c].roles.includes(role)).map((category) => ({
    category,
    ...effectivePreference(category, byCategory.get(category)),
    locked: Boolean(CATEGORIES[category].locked),
    /** Some categories have no type that can be emailed. */
    emailAvailable: Object.values(NOTIFICATION_TYPES).some((t) => t.category === category && t.email),
  }));
}

/** Types with several texts, chosen by `params.variant`. */
export const VARIANTS: Partial<Record<NotificationType, readonly string[]>> = {
  ACCOUNT_STATUS: ['ACTIVE', 'SUSPENDED', 'BLOCKED'],
  SUPPORT_DECIDED: ['APPROVED', 'DENIED'],
  /** DATED: runs until `end`; OPEN: no end date; CANCELED. */
  SUBSCRIPTION_CHANGED: ['DATED', 'OPEN', 'CANCELED'],
  /** Who wrote it: the center's administration or the platform. */
  ANNOUNCEMENT: ['CENTER', 'PLATFORM'],
  /** The role the new member joined as. */
  MEMBER_ADDED: ['TEACHER', 'STUDENT'],
  /** The meeting provider the teacher is asked to link. */
  MEETING_ACCOUNT_NEEDED: ['ZOOM', 'GOOGLE_MEET'],
};

/** Every template an email may be written from (each needs `notify.<template>.title/body`). */
export function emailTemplates(): string[] {
  return (Object.keys(NOTIFICATION_TYPES) as NotificationType[])
    .filter((t) => NOTIFICATION_TYPES[t].email)
    .flatMap((t) => VARIANTS[t]?.map((v) => `${t}.${v}`) ?? [t]);
}

/** Template key suffix: `ACCOUNT_STATUS.SUSPENDED` when the type has variants, else the type. */
export function templateOf(type: NotificationType, params: Record<string, unknown>): string {
  return typeof params.variant === 'string' && params.variant ? `${type}.${params.variant}` : type;
}
