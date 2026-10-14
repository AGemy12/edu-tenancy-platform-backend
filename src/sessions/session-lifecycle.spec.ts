import {
  EARLY_ENTRY_MIN,
  LIVE_GRACE_MIN,
  UNSTARTED_GRACE_MIN,
  canDelete,
  canReschedule,
  entryWindow,
  nextStatus,
  overdueCutoffs,
  unstartedOutcome,
} from './session-lifecycle.js';

const MIN = 60_000;

describe('nextStatus', () => {
  it('follows the lifecycle', () => {
    expect(nextStatus('SCHEDULED', 'start')).toBe('LIVE');
    expect(nextStatus('LIVE', 'start')).toBe('LIVE'); // re-opening a live meeting is fine
    expect(nextStatus('LIVE', 'complete')).toBe('COMPLETED');
    expect(nextStatus('SCHEDULED', 'complete')).toBe('COMPLETED');
    expect(nextStatus('MISSED', 'complete')).toBe('COMPLETED');
    expect(nextStatus('SCHEDULED', 'cancel')).toBe('CANCELED');
  });

  it('refuses everything else', () => {
    expect(nextStatus('LIVE', 'cancel')).toBeNull();
    expect(nextStatus('MISSED', 'start')).toBeNull();
    for (const action of ['start', 'complete', 'cancel'] as const) {
      expect(nextStatus('COMPLETED', action)).toBeNull();
      expect(nextStatus('CANCELED', action)).toBeNull();
    }
  });

  it('only lets scheduled sessions move', () => {
    expect(canReschedule('SCHEDULED')).toBe(true);
    expect(canReschedule('LIVE')).toBe(false);
    expect(canReschedule('COMPLETED')).toBe(false);
  });
});

describe('canDelete', () => {
  const now = new Date('2026-10-14T16:00:00Z');
  const later = new Date('2026-10-15T16:00:00Z');
  const earlier = new Date('2026-10-13T16:00:00Z');

  it('allows only a scheduled session whose time has not come', () => {
    expect(canDelete({ status: 'SCHEDULED', startAt: later }, now)).toBe(true);
    expect(canDelete({ status: 'SCHEDULED', startAt: earlier }, now)).toBe(false);
  });

  it('keeps every session that is part of the record', () => {
    for (const status of ['LIVE', 'COMPLETED', 'MISSED', 'CANCELED'] as const) {
      expect(canDelete({ status, startAt: later }, now)).toBe(false);
    }
  });
});

describe('entryWindow', () => {
  const startAt = new Date('2026-10-14T16:00:00Z');
  const at = (minutes: number) => new Date(startAt.getTime() + minutes * MIN);

  it(`opens ${EARLY_ENTRY_MIN} minutes before the start`, () => {
    expect(entryWindow({ status: 'SCHEDULED', startAt }, at(-EARLY_ENTRY_MIN - 1))).toBe('early');
    expect(entryWindow({ status: 'SCHEDULED', startAt }, at(-EARLY_ENTRY_MIN))).toBe('open');
  });

  it('lets people into a live session at any time, even early', () => {
    expect(entryWindow({ status: 'LIVE', startAt }, at(-60))).toBe('open');
    expect(entryWindow({ status: 'LIVE', startAt }, at(300))).toBe('open');
  });

  it('is closed once the session is over', () => {
    for (const status of ['COMPLETED', 'CANCELED', 'MISSED'] as const) {
      expect(entryWindow({ status, startAt }, at(0))).toBe('closed');
    }
  });
});

describe('overdue sessions', () => {
  it('gives live sessions longer than unstarted ones', () => {
    const now = new Date('2026-10-14T20:00:00Z');
    const { liveEndedBefore, unstartedEndedBefore } = overdueCutoffs(now);
    expect(now.getTime() - liveEndedBefore.getTime()).toBe(LIVE_GRACE_MIN * MIN);
    expect(now.getTime() - unstartedEndedBefore.getTime()).toBe(UNSTARTED_GRACE_MIN * MIN);
    expect(LIVE_GRACE_MIN).toBeGreaterThan(UNSTARTED_GRACE_MIN);
  });

  it('marks a session missed only when Zoom could have told us it started', () => {
    expect(unstartedOutcome('ZOOM', true)).toBe('MISSED');
    expect(unstartedOutcome('ZOOM', false)).toBe('COMPLETED');
    expect(unstartedOutcome('GOOGLE_MEET', true)).toBe('COMPLETED');
    expect(unstartedOutcome('MANUAL', true)).toBe('COMPLETED');
  });
});
