import { describe, expect, it } from 'vitest';
import {
  currentTurnEvents,
  dedupeReplay,
  isReplay,
  partitionReplay,
  replayIdentity,
  type QuarantinableEvent,
} from '../src/domain/replay-quarantine.js';

// Tiny inline builders, mirroring stall-detector.test.ts / guardrail-progress.test.ts's idiom.
const ev = (id: string, replay?: boolean): QuarantinableEvent & { id: string } => {
  const base: QuarantinableEvent & { id: string } = { id, type: 'session_update', payload: { id } };
  return replay === undefined ? base : { ...base, replay };
};

describe('isReplay (issue #144)', () => {
  it('is true only when replay is exactly true', () => {
    expect(isReplay(ev('a', true))).toBe(true);
  });

  it('is false when replay is false', () => {
    expect(isReplay(ev('a', false))).toBe(false);
  });

  it('is false when replay is explicitly undefined', () => {
    expect(isReplay(ev('a', undefined))).toBe(false);
  });

  it('is false when replay is absent', () => {
    expect(isReplay(ev('a'))).toBe(false);
  });
});

describe('partitionReplay (issue #144)', () => {
  it('splits a mixed stream into history/current, order preserved within each bucket', () => {
    const events = [ev('1', true), ev('2', false), ev('3', true), ev('4'), ev('5', true)];
    const { history, current } = partitionReplay(events);
    expect(history.map((e) => e.id)).toEqual(['1', '3', '5']);
    expect(current.map((e) => e.id)).toEqual(['2', '4']);
  });

  it('an all-replay stream yields an empty current bucket', () => {
    const events = [ev('1', true), ev('2', true)];
    const { history, current } = partitionReplay(events);
    expect(history.map((e) => e.id)).toEqual(['1', '2']);
    expect(current).toEqual([]);
  });

  it('an all-current stream yields an empty history bucket', () => {
    const events = [ev('1', false), ev('2')];
    const { history, current } = partitionReplay(events);
    expect(current.map((e) => e.id)).toEqual(['1', '2']);
    expect(history).toEqual([]);
  });

  it('empty input yields both buckets empty', () => {
    const { history, current } = partitionReplay([]);
    expect(history).toEqual([]);
    expect(current).toEqual([]);
  });
});

describe('currentTurnEvents (issue #144)', () => {
  it('drops replay-flagged events and keeps the rest in order', () => {
    const events = [ev('1', true), ev('2', false), ev('3'), ev('4', true), ev('5')];
    expect(currentTurnEvents(events).map((e) => e.id)).toEqual(['2', '3', '5']);
  });
});

describe('replayIdentity (issue #144)', () => {
  it('two tool_call_updates with the same toolCallId but different status get different identities', () => {
    const a = replayIdentity({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' });
    const b = replayIdentity({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'failed' });
    expect(a).not.toBe(b);
  });

  it('same toolCallId+status yields the same identity even if other fields differ', () => {
    const a = replayIdentity({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      content: [{ type: 'text', text: 'first run output' }],
    });
    const b = replayIdentity({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      content: [{ type: 'text', text: 'a totally different transcript' }],
      extra: 'ignored',
    });
    expect(a).toBe(b);
  });

  it('two id-less agent_message_chunks with identical content get the same identity', () => {
    const a = replayIdentity({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } });
    const b = replayIdentity({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } });
    expect(a).toBe(b);
  });

  it('two id-less agent_message_chunks with different content get different identities', () => {
    const a = replayIdentity({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } });
    const b = replayIdentity({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'goodbye' } });
    expect(a).not.toBe(b);
  });

  it('an update missing sessionUpdate falls back to kind "unknown", matching an explicit "unknown"', () => {
    const missing = replayIdentity({ toolCallId: 'tc-1', status: 'completed' });
    const explicit = replayIdentity({ sessionUpdate: 'unknown', toolCallId: 'tc-1', status: 'completed' });
    expect(missing).toBe(explicit);
  });

  it('does not throw on a circular object', () => {
    const c: any = {};
    c.self = c;
    c.sessionUpdate = 'x';
    expect(() => replayIdentity(c)).not.toThrow();
    expect(typeof replayIdentity(c)).toBe('string');
  });
});

describe('dedupeReplay (issue #144)', () => {
  it('collapses within-batch duplicates to the first occurrence', () => {
    const dup = { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' };
    const other = { sessionUpdate: 'tool_call_update', toolCallId: 'tc-2', status: 'completed' };
    const { novel, identities } = dedupeReplay(new Set(), [dup, other, dup]);
    expect(novel).toEqual([dup, other]);
    expect(identities).toEqual([replayIdentity(dup), replayIdentity(other)]);
  });

  it('drops updates whose identity is already in seen', () => {
    const known = { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' };
    const fresh = { sessionUpdate: 'tool_call_update', toolCallId: 'tc-2', status: 'completed' };
    const seen = new Set([replayIdentity(known)]);
    const { novel, identities } = dedupeReplay(seen, [known, fresh]);
    expect(novel).toEqual([fresh]);
    expect(identities).toEqual([replayIdentity(fresh)]);
  });

  it('never mutates the seen set', () => {
    const known = { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' };
    const fresh = { sessionUpdate: 'tool_call_update', toolCallId: 'tc-2', status: 'completed' };
    const seen = new Set([replayIdentity(known)]);
    const sizeBefore = seen.size;
    dedupeReplay(seen, [known, fresh]);
    expect(seen.size).toBe(sizeBefore);
    expect(seen.has(replayIdentity(fresh))).toBe(false);
  });

  it('returns identities aligned positionally with novel', () => {
    const a = { sessionUpdate: 'tool_call_update', toolCallId: 'tc-a', status: 'completed' };
    const b = { sessionUpdate: 'tool_call_update', toolCallId: 'tc-b', status: 'failed' };
    const { novel, identities } = dedupeReplay(new Set(), [a, b]);
    expect(identities).toEqual(novel.map((u) => replayIdentity(u)));
  });

  it('empty updates yields empty novel', () => {
    const { novel, identities } = dedupeReplay(new Set(), []);
    expect(novel).toEqual([]);
    expect(identities).toEqual([]);
  });
});
