import type { AttendanceStatus } from '../generated/prisma/enums.js';

/** What the teacher records for one student after a session. */
export type Evaluation = {
  status: AttendanceStatus;
  rating?: number | null;
  homework?: string | null;
  progress?: string | null;
  comment?: string | null;
};

const text = (v: string | null | undefined) => {
  const t = v?.trim();
  return t ? t : null;
};

/**
 * The attendee row an evaluation produces. The status decides `attended` (what billing and reports
 * count): present and late students attended, absent ones didn't, and absent students get no rating.
 */
export function evaluationRow(e: Evaluation, now = new Date()) {
  const absent = e.status === 'ABSENT';
  return {
    status: e.status,
    attended: !absent,
    rating: absent ? null : (e.rating ?? null),
    homework: text(e.homework),
    progress: text(e.progress),
    comment: text(e.comment),
    evaluatedAt: now,
  };
}
