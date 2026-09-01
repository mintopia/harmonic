import { describe, expect, it } from 'vitest';
import { issueRef, taskKey, taskLabel, ticketIdentity, ticketRowId } from '../web/src/id-format.js';

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

  it('shows both ids compactly in a listing, tracker ref first', () => {
    expect(ticketRowId(430, 436)).toBe('#436 · T-430');
  });

  it('shows only the task key in a listing when there is no tracker ref', () => {
    expect(ticketRowId(430, null)).toBe('T-430');
    expect(ticketRowId(430, undefined)).toBe('T-430');
  });
});
