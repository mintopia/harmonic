import { describe, expect, it } from 'vitest';
import {
  applyAttentionMessage,
  attentionTarget,
  clearAllAttention,
  clearAttention,
  hasAttention,
  markAttention,
  NO_ATTENTION,
  type AttentionCandidate,
} from '../web/src/conversation-attention-model.js';

describe('hasAttention / markAttention / clearAttention / clearAllAttention', () => {
  it('starts empty', () => {
    expect(hasAttention(NO_ATTENTION)).toBe(false);
  });

  it('marks a Conversation id, flipping hasAttention true', () => {
    const state = markAttention(NO_ATTENTION, 5);
    expect(hasAttention(state)).toBe(true);
    expect(state.has(5)).toBe(true);
  });

  it('marking the same id twice returns the same reference (no unnecessary re-render)', () => {
    const first = markAttention(NO_ATTENTION, 5);
    const second = markAttention(first, 5);
    expect(second).toBe(first);
  });

  it('clearAttention drops one id, leaving others', () => {
    const state = markAttention(markAttention(NO_ATTENTION, 5), 7);
    const next = clearAttention(state, 5);
    expect(next.has(5)).toBe(false);
    expect(next.has(7)).toBe(true);
  });

  it('clearAttention on an absent id is a same-reference no-op', () => {
    const state = markAttention(NO_ATTENTION, 5);
    expect(clearAttention(state, 999)).toBe(state);
  });

  it('clearAllAttention empties the set and hasAttention goes false', () => {
    const state = markAttention(markAttention(NO_ATTENTION, 5), 7);
    const cleared = clearAllAttention(state);
    expect(hasAttention(cleared)).toBe(false);
  });

  it('clearAllAttention on an already-empty state is a same-reference no-op', () => {
    expect(clearAllAttention(NO_ATTENTION)).toBe(NO_ATTENTION);
  });
});

describe('attentionTarget', () => {
  it('targets the conversationId on a permission_request', () => {
    const msg: AttentionCandidate = { type: 'permission_request', conversationId: 3 };
    expect(attentionTarget(msg)).toBe(3);
  });

  it('targets the event.conversationId on a finished lifecycle conversation_event', () => {
    const msg: AttentionCandidate = {
      type: 'conversation_event',
      event: { type: 'lifecycle', conversationId: 9, payload: { event: 'finished' } },
    };
    expect(attentionTarget(msg)).toBe(9);
  });

  it('ignores a lifecycle error — that is surfaced as a failure elsewhere', () => {
    const msg: AttentionCandidate = {
      type: 'conversation_event',
      event: { type: 'lifecycle', conversationId: 9, payload: { event: 'error' } },
    };
    expect(attentionTarget(msg)).toBeNull();
  });

  it('ignores a non-lifecycle conversation_event (e.g. session_update)', () => {
    const msg: AttentionCandidate = {
      type: 'conversation_event',
      event: { type: 'session_update', conversationId: 9, payload: {} },
    };
    expect(attentionTarget(msg)).toBeNull();
  });

  it('ignores conversation_changed, run_event, run_changed, and task_changed', () => {
    expect(attentionTarget({ type: 'conversation_changed' })).toBeNull();
    expect(attentionTarget({ type: 'run_event' })).toBeNull();
    expect(attentionTarget({ type: 'run_changed' })).toBeNull();
    expect(attentionTarget({ type: 'task_changed' })).toBeNull();
  });
});

describe('applyAttentionMessage', () => {
  it('marks the target when nothing is focused (panel collapsed or on the list)', () => {
    const msg: AttentionCandidate = { type: 'permission_request', conversationId: 3 };
    const state = applyAttentionMessage(NO_ATTENTION, msg, null);
    expect(state.has(3)).toBe(true);
  });

  it('does not mark the target when it is the focused Conversation', () => {
    const msg: AttentionCandidate = { type: 'permission_request', conversationId: 3 };
    const state = applyAttentionMessage(NO_ATTENTION, msg, 3);
    expect(hasAttention(state)).toBe(false);
  });

  it('marks a different, non-focused Conversation even while another one is focused', () => {
    const msg: AttentionCandidate = { type: 'permission_request', conversationId: 3 };
    const state = applyAttentionMessage(NO_ATTENTION, msg, 4);
    expect(state.has(3)).toBe(true);
  });

  it('returns the same reference for a message attention does not care about', () => {
    const state = markAttention(NO_ATTENTION, 5);
    const next = applyAttentionMessage(state, { type: 'run_changed' }, null);
    expect(next).toBe(state);
  });
});
