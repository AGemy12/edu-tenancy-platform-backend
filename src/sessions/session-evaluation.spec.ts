import { describe, expect, it } from 'vitest';
import { evaluationRow } from './session-evaluation.js';

const now = new Date('2026-10-20T18:00:00Z');

describe('evaluationRow', () => {
  it('counts present and late students as attended', () => {
    expect(evaluationRow({ status: 'PRESENT', rating: 9 }, now)).toMatchObject({ attended: true, rating: 9, evaluatedAt: now });
    expect(evaluationRow({ status: 'LATE', rating: 6 }, now)).toMatchObject({ attended: true, rating: 6 });
  });

  it('drops the rating of an absent student but keeps homework and notes', () => {
    expect(evaluationRow({ status: 'ABSENT', rating: 7, homework: 'Page 30', comment: 'Catch up' }, now)).toMatchObject({
      attended: false,
      rating: null,
      homework: 'Page 30',
      comment: 'Catch up',
    });
  });

  it('stores blank text as nothing', () => {
    expect(evaluationRow({ status: 'PRESENT', homework: '   ', progress: '', comment: undefined }, now)).toMatchObject({
      homework: null,
      progress: null,
      comment: null,
      rating: null,
    });
  });
});
