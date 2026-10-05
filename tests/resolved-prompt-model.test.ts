import { describe, expect, it } from 'vitest';
import {
  finishedTurnCount,
  placeTurnPrompts,
  splitTurnPrompts,
  turnBoundaryAnchors,
} from '../web/src/resolved-prompt-model.js';

const msg = (id: number) => ({ id, type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk' } });
const finished = (id: number) => ({ id, type: 'lifecycle', payload: { event: 'finished' } });

describe('splitTurnPrompts', () => {
  it('splits on the exact separator and leaves each prompt untouched', () => {
    expect(splitTurnPrompts('first\n  body\n\n---\n\nsecond\n')).toEqual(['first\n  body', 'second\n']);
  });
  it('does not split on a markdown rule inside a prompt', () => {
    expect(splitTurnPrompts('a\n---\nb')).toEqual(['a\n---\nb']);
  });
  it('yields nothing for empty text', () => {
    expect(splitTurnPrompts('')).toEqual([]);
  });
});

describe('turnBoundaryAnchors', () => {
  it('anchors on the first event after each finished turn, skipping a trailing finish', () => {
    const events = [msg(1), finished(2), msg(3), msg(4), finished(5), msg(6), finished(7)];
    expect(turnBoundaryAnchors(events)).toEqual([3, 6]);
    expect(finishedTurnCount(events)).toBe(3);
  });
  it('has no anchors without turn boundaries', () => {
    expect(turnBoundaryAnchors([msg(1), msg(2)])).toEqual([]);
  });
});

describe('placeTurnPrompts', () => {
  it('places turn N+1 before the row that follows turn N', () => {
    const { before, trailing } = placeTurnPrompts(['p2', 'p3'], [3, 6], [1, 2, 3, 4, 5, 6]);
    expect(before.get(3)).toEqual([{ turn: 2, text: 'p2' }]);
    expect(before.get(6)).toEqual([{ turn: 3, text: 'p3' }]);
    expect(trailing).toEqual([]);
  });
  it('moves an anchor swallowed by coalescing to the next rendered row', () => {
    const { before } = placeTurnPrompts(['p2'], [3], [1, 2, 4]);
    expect(before.get(4)).toEqual([{ turn: 2, text: 'p2' }]);
  });
  it('degrades to an in-order trailing list when there are no boundaries', () => {
    const { before, trailing } = placeTurnPrompts(['p2', 'p3'], [], [1, 2]);
    expect(before.size).toBe(0);
    expect(trailing.map((p) => p.turn)).toEqual([2, 3]);
  });
  it('drops prompts whose boundary is in the hidden earlier tail', () => {
    const { before, trailing } = placeTurnPrompts(['p2', 'p3'], [3, 60], [50, 55, 60]);
    expect(before.get(60)).toEqual([{ turn: 3, text: 'p3' }]);
    expect(trailing).toEqual([]);
  });
});
