import { describe, expect, it } from 'vitest';
import { parseSkipReasonTaskRef } from '../web/src/skip-reason-model.js';

/**
 * The lease skip-reason (issue #176) is a dead-end string — "Work Context
 * held by task 12 (running)" names the holder but gives the operator
 * nothing to click. `parseSkipReasonTaskRef` is the pure part: pull the
 * holder's task id out of the `task <id>` pattern so the caller can turn
 * it into a link, or `null` when there's nothing to link to.
 */
describe('parseSkipReasonTaskRef', () => {
  it('extracts the holder id from the canonical server format', () => {
    expect(parseSkipReasonTaskRef('Work Context held by task 12 (running)')).toBe(12);
  });

  it('returns null for null input', () => {
    expect(parseSkipReasonTaskRef(null)).toBeNull();
  });

  it('returns null for a string with no task reference', () => {
    expect(parseSkipReasonTaskRef('Blocked on dependencies')).toBeNull();
  });

  it('returns null for a differently-worded reason with no id', () => {
    // Same "held by" shape but no `<id>` to link — must not false-match.
    expect(parseSkipReasonTaskRef('Work Context held by another run')).toBeNull();
  });

  it.each([
    'At capacity',
    'Integration branch missing',
    'Git backoff',
    'Workspace disabled',
    'HITL',
  ])('leaves non-lease scheduler reasons as plain text', (reason) => {
    // Issue #238 expands the API beyond Work Context leases. These reasons
    // have no Task to link, but the Ticket and Deck still render their text.
    expect(parseSkipReasonTaskRef(reason)).toBeNull();
  });
});
