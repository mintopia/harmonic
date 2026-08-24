import { describe, expect, it } from 'vitest';
import {
  advanceReviewAnnouncements,
  EMPTY_REVIEW_ANNOUNCEMENT_CURSOR,
  type ReviewAnnouncementTask,
} from '../web/src/review-announce-model.js';

const task = (
  id: number,
  state: ReviewAnnouncementTask['state'],
  prompt = `Task ${id}`,
): ReviewAnnouncementTask => ({ id, prompt, state });

describe('review announcements', () => {
  it('seeds the loaded board without replaying its backlog', () => {
    const result = advanceReviewAnnouncements(
      [task(1, 'awaiting-review')],
      1,
      EMPTY_REVIEW_ANNOUNCEMENT_CURSOR,
    );

    expect(result.polite).toBe('');
    expect(result.assertive).toBe('');
  });

  it('politely announces a Task entering review with the updated Needs-you count', () => {
    const seeded = advanceReviewAnnouncements([task(1, 'running')], 0, EMPTY_REVIEW_ANNOUNCEMENT_CURSOR);
    const result = advanceReviewAnnouncements([task(1, 'awaiting-review', 'Check contrast')], 1, seeded.cursor);

    expect(result.polite).toBe('Check contrast is ready for review. Needs you: 1.');
    expect(result.assertive).toBe('');
  });

  it('uses an assertive merge outcome when review completes', () => {
    const seeded = advanceReviewAnnouncements([task(1, 'awaiting-review', 'Add live region')], 1, EMPTY_REVIEW_ANNOUNCEMENT_CURSOR);
    const result = advanceReviewAnnouncements([task(1, 'completed', 'Add live region')], 0, seeded.cursor);

    expect(result.polite).toBe('Needs you: 0.');
    expect(result.assertive).toBe('Add live region merged.');
  });

  it('politely announces a rejected review Task without claiming that its merge failed', () => {
    const seeded = advanceReviewAnnouncements([task(1, 'awaiting-review', 'Add live region')], 1, EMPTY_REVIEW_ANNOUNCEMENT_CURSOR);
    const result = advanceReviewAnnouncements([task(1, 'failed', 'Add live region')], 0, seeded.cursor);

    expect(result.polite).toBe('Add live region left review. Needs you: 0.');
    expect(result.assertive).toBe('');
  });

  it('keeps every review transition from a batched refresh', () => {
    const seeded = advanceReviewAnnouncements(
      [task(1, 'running', 'Check contrast'), task(2, 'awaiting-review', 'Add live region')],
      1,
      EMPTY_REVIEW_ANNOUNCEMENT_CURSOR,
    );
    const result = advanceReviewAnnouncements(
      [task(1, 'awaiting-review', 'Check contrast'), task(2, 'completed', 'Add live region')],
      1,
      seeded.cursor,
    );

    expect(result.polite).toBe('Check contrast is ready for review.');
    expect(result.assertive).toBe('Add live region merged.');
  });

  it('is silent for unchanged snapshots and unrelated state changes', () => {
    const seeded = advanceReviewAnnouncements([task(1, 'running')], 0, EMPTY_REVIEW_ANNOUNCEMENT_CURSOR);
    const unchanged = advanceReviewAnnouncements([task(1, 'running')], 0, seeded.cursor);
    const unrelated = advanceReviewAnnouncements([task(1, 'ready')], 0, unchanged.cursor);

    expect(unchanged.polite).toBe('');
    expect(unchanged.assertive).toBe('');
    expect(unrelated.polite).toBe('');
    expect(unrelated.assertive).toBe('');
  });

  it('politely announces a count-only change exactly once', () => {
    const seeded = advanceReviewAnnouncements([task(1, 'ready')], 0, EMPTY_REVIEW_ANNOUNCEMENT_CURSOR);
    const changed = advanceReviewAnnouncements([task(1, 'ready')], 2, seeded.cursor);
    const repeated = advanceReviewAnnouncements([task(1, 'ready')], 2, changed.cursor);

    expect(changed.polite).toBe('Needs you: 2.');
    expect(repeated.polite).toBe('');
  });
});
