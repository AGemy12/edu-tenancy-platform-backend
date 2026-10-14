import type { SessionProvider, SessionStatus } from '../generated/prisma/enums.js';

/**
 * Session lifecycle.
 *
 *   SCHEDULED ──start──▶ LIVE ──complete──▶ COMPLETED
 *       │                                      ▲
 *       ├──complete (held, but never started here)
 *       ├──cancel──▶ CANCELED
 *       └──(time passes, never started)──▶ MISSED or COMPLETED
 *   MISSED ──complete──▶ COMPLETED   (the teacher confirms it did take place)
 *
 * "start" happens when the host opens the meeting from the platform or when Zoom reports
 * `meeting.started`; "complete" when the host ends it or Zoom reports `meeting.ended`.
 * COMPLETED and CANCELED are final.
 */
export type SessionAction = 'start' | 'complete' | 'cancel';

const TRANSITIONS: Record<SessionStatus, Partial<Record<SessionAction, SessionStatus>>> = {
  SCHEDULED: { start: 'LIVE', complete: 'COMPLETED', cancel: 'CANCELED' },
  LIVE: { start: 'LIVE', complete: 'COMPLETED' },
  MISSED: { complete: 'COMPLETED' },
  COMPLETED: {},
  CANCELED: {},
};

/** Hosts and students may enter the meeting this long before it starts. */
export const EARLY_ENTRY_MIN = 15;
/** A session nobody started is closed this long after its planned end. */
export const UNSTARTED_GRACE_MIN = 30;
/** A live session with no end event is closed this long after its planned end (classes run over). */
export const LIVE_GRACE_MIN = 180;

const MIN = 60_000;

/** The status after `action`, or null when the action isn't allowed from `status`. */
export function nextStatus(status: SessionStatus, action: SessionAction): SessionStatus | null {
  return TRANSITIONS[status][action] ?? null;
}

/** Scheduled or live: the meeting can still be entered, edited by provider events, or ended. */
export function isOpen(status: SessionStatus) {
  return status === 'SCHEDULED' || status === 'LIVE';
}

/**
 * Only a session that hasn't started (and whose time hasn't come) can be deleted. Anything that
 * started, ended, was missed or was canceled backs attendance, evaluations, billing and reports.
 */
export function canDelete(s: { status: SessionStatus; startAt: Date }, now = new Date()) {
  return s.status === 'SCHEDULED' && s.startAt > now;
}

/** Only a session that hasn't started can be moved or have its link changed. */
export function canReschedule(status: SessionStatus) {
  return status === 'SCHEDULED';
}

/** Whether someone may enter the meeting now. A live session stays open even past its planned end. */
export function entryWindow(s: { status: SessionStatus; startAt: Date }, now: Date): 'early' | 'open' | 'closed' {
  if (!isOpen(s.status)) return 'closed';
  if (s.status === 'SCHEDULED' && now.getTime() < s.startAt.getTime() - EARLY_ENTRY_MIN * MIN) return 'early';
  return 'open';
}

/** Sessions whose planned end is before these instants are overdue (see `closeOverdue`). */
export function overdueCutoffs(now: Date) {
  return {
    liveEndedBefore: new Date(now.getTime() - LIVE_GRACE_MIN * MIN),
    unstartedEndedBefore: new Date(now.getTime() - UNSTARTED_GRACE_MIN * MIN),
  };
}

/**
 * What an overdue session that never started becomes. Only Zoom (with webhooks) can tell us a
 * meeting really didn't happen; for Meet and manual links the teacher may simply have joined from
 * elsewhere, so we assume it took place rather than accuse them of missing it.
 */
export function unstartedOutcome(provider: SessionProvider, zoomEventsEnabled: boolean): SessionStatus {
  return provider === 'ZOOM' && zoomEventsEnabled ? 'MISSED' : 'COMPLETED';
}
