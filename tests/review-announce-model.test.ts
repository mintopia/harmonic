import { describe, expect, it } from 'vitest';
import {
  advanceReviewAnnouncements,
  EMPTY_REVIEW_ANNOUNCEMENT_CURSOR,
  type ReviewAnnouncementTask,
} from '../web/src/review-announce-model.js';

const task = (
  id: number,
  state: ReviewAnnouncementTask['state'],
  summary = `Task ${id}`,
): ReviewAnnouncementTask => ({ id, summary, state });

describe('attention announcements (ADR-0041)', () => {
  it('seeds the loaded board without replaying its backlog', () => {
    const result = advanceReviewAnnouncements([task(1, 'escalated')], 1, EMPTY_REVIEW_ANNOUNCEMENT_CURSOR);

    expect(result.polite).toBe('');
    expect(result.assertive).toBe('');
  });

  it('politely announces a Task escalating with the updated Needs-you count', () => {
    const seeded = advanceReviewAnnouncements([task(1, 'working')], 0, EMPTY_REVIEW_ANNOUNCEMENT_CURSOR);
    const result = advanceReviewAnnouncements([task(1, 'escalated', 'Check contrast')], 1, seeded.cursor);

    expect(result.polite).toBe('Check contrast needs you: escalated. Needs you: 1.');
    expect(result.assertive).toBe('');
  });

  it('uses an assertive merge outcome when an escalated Task is accepted', () => {
    const seeded = advanceReviewAnnouncements([task(1, 'escalated', 'Add live region')], 1, EMPTY_REVIEW_ANNOUNCEMENT_CURSOR);
    const result = advanceReviewAnnouncements([task(1, 'done', 'Add live region')], 0, seeded.cursor);

    expect(result.polite).toBe('Needs you: 0.');
    expect(result.assertive).toBe('Add live region merged.');
  });

  it('uses an assertive merge outcome when a working Task merges on its own', () => {
    const seeded = advanceReviewAnnouncements([task(1, 'working', 'Add live region')], 0, EMPTY_REVIEW_ANNOUNCEMENT_CURSOR);
    const result = advanceReviewAnnouncements([task(1, 'done', 'Add live region')], 0, seeded.cursor);

    expect(result.polite).toBe('');
    expect(result.assertive).toBe('Add live region merged.');
  });

  it('politely announces a rejected-with-guidance Task resuming, never claiming its merge failed', () => {
    const seeded = advanceReviewAnnouncements([task(1, 'escalated', 'Add live region')], 1, EMPTY_REVIEW_ANNOUNCEMENT_CURSOR);
    const result = advanceReviewAnnouncements([task(1, 'working', 'Add live region')], 0, seeded.cursor);

    expect(result.polite).toBe('Add live region left escalation. Needs you: 0.');
    expect(result.assertive).toBe('');
  });

  it('politely announces a closed escalation leaving the surface', () => {
    const seeded = advanceReviewAnnouncements([task(1, 'escalated', 'Add live region')], 1, EMPTY_REVIEW_ANNOUNCEMENT_CURSOR);
    const result = advanceReviewAnnouncements([task(1, 'cancelled', 'Add live region')], 0, seeded.cursor);

    expect(result.polite).toBe('Add live region left escalation. Needs you: 0.');
    expect(result.assertive).toBe('');
  });

  it('keeps every attention transition from a batched refresh', () => {
    const seeded = advanceReviewAnnouncements(
      [task(1, 'working', 'Check contrast'), task(2, 'escalated', 'Add live region')],
      1,
      EMPTY_REVIEW_ANNOUNCEMENT_CURSOR,
    );
    const result = advanceReviewAnnouncements(
      [task(1, 'escalated', 'Check contrast'), task(2, 'done', 'Add live region')],
      1,
      seeded.cursor,
    );

    expect(result.polite).toBe('Check contrast needs you: escalated.');
    expect(result.assertive).toBe('Add live region merged.');
  });

  it('is silent for unchanged snapshots and unrelated state changes', () => {
    const seeded = advanceReviewAnnouncements([task(1, 'working')], 0, EMPTY_REVIEW_ANNOUNCEMENT_CURSOR);
    const unchanged = advanceReviewAnnouncements([task(1, 'working')], 0, seeded.cursor);
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
