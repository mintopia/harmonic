import { describe, expect, it } from 'vitest';
import {
  placeTurnPrompts,
  promptSentAnchors,
  promptSentCount,
} from '../web/src/resolved-prompt-model.js';

const msg = (id: number) => ({ id, type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk' } });
const finished = (id: number) => ({ id, type: 'lifecycle', payload: { event: 'finished' } });
const sent = (id: number) => ({ id, type: 'lifecycle', payload: { event: 'prompt_sent' } });

describe('promptSentAnchors', () => {
  it('anchors turn 2+ on their prompt_sent markers, ignoring finished', () => {
    const events = [sent(1), msg(2), sent(3), msg(4), sent(5), msg(6), finished(7), sent(8), msg(9), finished(10)];
    expect(promptSentAnchors(events)).toEqual([3, 5, 8]);
    expect(promptSentCount(events)).toBe(4);
  });
  it('has no anchors without markers or with a single prompt', () => {
    expect(promptSentAnchors([msg(1), finished(2)])).toEqual([]);
    expect(promptSentAnchors([sent(1), msg(2)])).toEqual([]);
    expect(promptSentCount([msg(1)])).toBe(0);
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
