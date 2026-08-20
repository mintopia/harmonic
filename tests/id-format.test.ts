import { describe, expect, it } from 'vitest';
import { issueRef, taskKey, taskLabel, ticketIdentity } from '../web/src/id-format.js';

/**
 * Task ids and tracker (GitHub issue) refs are two different number spaces that
 * used to collide as bare `#n` (issue #192). These formatters are the single
 * place that decides how each space is written: a task id is never a bare `#n`;
 * `#n` is reserved for a tracker issue (GitHub's own convention).
 */
describe('id-format', () => {
  it('writes a task id as a `T-` key in compact slots, never a bare `#`', () => {
    expect(taskKey(174)).toBe('T-174');
    expect(taskKey(1)).toBe('T-1');
    expect(taskKey(174)).not.toContain('#');
  });

  it('writes a task id as `Task n` in prose, never a bare `#`', () => {
    expect(taskLabel(174)).toBe('Task 174');
    expect(taskLabel(174)).not.toContain('#');
  });

  it('reserves `#n` for a tracker issue ref (GitHub convention)', () => {
    expect(issueRef(185)).toBe('#185');
  });

  it('shows both spaces disambiguated when a task mirrors an issue', () => {
    expect(ticketIdentity(174, 185)).toBe('Task 174 · issue #185');
  });

  it('shows only the task label when there is no tracker ref', () => {
    expect(ticketIdentity(174, null)).toBe('Task 174');
    expect(ticketIdentity(174, undefined)).toBe('Task 174');
  });
});
