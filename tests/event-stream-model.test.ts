import { describe, expect, it } from 'vitest';
import { coalesceEvents, coalesceTail, MAX_STREAM_EVENTS, movingBaseView } from '../web/src/event-stream-model.js';
import type { RunEvent } from '../web/src/types.js';

const evt = (id: number, type: RunEvent['type'], payload: any): RunEvent => ({
  id,
  runId: 1,
  seq: id,
  ts: id,
  type,
  payload,
});

const chunk = (id: number, text: string, sessionUpdate = 'agent_message_chunk'): RunEvent =>
  evt(id, 'session_update', { sessionUpdate, content: { type: 'text', text } });

describe('coalesceEvents', () => {
  it('folds consecutive message chunks into one text item so words reflow', () => {
    // These are the exact byte-boundary splits that broke words mid-line.
    const items = coalesceEvents([chunk(1, 'I searched the de'), chunk(2, 'ferred tool list.')]);
    expect(items).toEqual([
      { kind: 'text', variant: 'message', text: 'I searched the deferred tool list.', key: 1 },
    ]);
  });

  it('does not merge message text with thought text', () => {
    const items = coalesceEvents([
      chunk(1, 'thinking', 'agent_thought_chunk'),
      chunk(2, 'answer'),
    ]);
    expect(items.map((i) => i.kind === 'text' && i.variant)).toEqual(['thought', 'message']);
  });

  it('splits a text run around a tool call, keeping each side coalesced', () => {
    const tool = evt(3, 'session_update', {
      sessionUpdate: 'tool_call',
      toolCallId: 'toolu_x',
      kind: 'read',
      title: 'Read',
      status: 'completed',
    });
    const items = coalesceEvents([chunk(1, 'before '), chunk(2, 'tool.'), tool, chunk(4, 'after '), chunk(5, 'tool.')]);
    expect(items).toEqual([
      { kind: 'text', variant: 'message', text: 'before tool.', key: 1 },
      {
        kind: 'tool',
        tool: { toolCallId: 'toolu_x', toolKind: 'read', title: 'Read', status: 'completed', subagent: false },
        key: 3,
      },
      { kind: 'text', variant: 'message', text: 'after tool.', key: 4 },
    ]);
  });

  it('folds a tool_call and its later tool_call_update into one row, advancing status', () => {
    // The exact double-render from the screenshot: a call, then its update.
    const call = evt(1, 'session_update', {
      sessionUpdate: 'tool_call',
      toolCallId: 'toolu_01EtAM',
      kind: 'read',
      title: 'notes.md',
      status: 'pending',
    });
    const update = evt(2, 'session_update', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'toolu_01EtAM',
      status: 'completed',
    });
    const items = coalesceEvents([call, update]);
    expect(items).toEqual([
      {
        kind: 'tool',
        tool: { toolCallId: 'toolu_01EtAM', toolKind: 'read', title: 'notes.md', status: 'completed', subagent: false },
        key: 1,
      },
    ]);
  });

  it('carries the call title through an update that only advances status', () => {
    const call = evt(1, 'session_update', { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run tests', kind: 'execute' });
    const update = evt(2, 'session_update', { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    const [item] = coalesceEvents([call, update]);
    expect(item).toEqual({
      kind: 'tool',
      tool: { toolCallId: 't1', toolKind: 'execute', title: 'Run tests', status: 'completed', subagent: false },
      key: 1,
    });
  });

  it('flags a subagent tool call from its parentToolUseId', () => {
    const call = evt(1, 'session_update', {
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'grep',
      _meta: { claudeCode: { parentToolUseId: 'toolu_parent' } },
    });
    const [item] = coalesceEvents([call]);
    expect(item && item.kind === 'tool' && item.tool.subagent).toBe(true);
  });

  it('passes non-text events through untouched', () => {
    const perm = evt(1, 'permission_request', { request: {}, outcome: { outcome: 'selected' } });
    const items = coalesceEvents([perm]);
    expect(items).toEqual([{ kind: 'event', event: perm, key: 1 }]);
  });

  it('tolerates chunks with missing text', () => {
    const items = coalesceEvents([chunk(1, 'a'), evt(2, 'session_update', { sessionUpdate: 'agent_message_chunk' })]);
    expect(items).toEqual([{ kind: 'text', variant: 'message', text: 'a', key: 1 }]);
  });
});

describe('moving-base folding (ADR-0046, #368)', () => {
  const retry = (id: number, attempt: number, of: number): RunEvent =>
    evt(id, 'lifecycle', { event: 'moving-base', attempt, of });

  it('folds every rebase re-entry into one row, kept at its first-seen position with the latest attempt', () => {
    const items = coalesceEvents([retry(1, 1, 5), retry(2, 2, 5), retry(3, 3, 5)]);
    // One row, first event's key, payload advanced to the latest attempt.
    expect(items).toEqual([{ kind: 'event', event: retry(3, 3, 5), key: 1 }]);
  });

  it('keeps the reconciling line in place as other events interleave between retries', () => {
    const other = (id: number) => evt(id, 'lifecycle', { event: 'progress-nudge', pattern: 'monologue' });
    const items = coalesceEvents([retry(1, 1, 5), other(2), retry(3, 2, 5), other(4)]);
    expect(items.map((i) => i.key)).toEqual([1, 2, 4]);
    // The single moving-base row still holds the newest attempt payload.
    expect(items[0]).toEqual({ kind: 'event', event: retry(3, 2, 5), key: 1 });
  });
});

describe('movingBaseView (ADR-0046, #368)', () => {
  it('is null for any non-moving-base payload', () => {
    expect(movingBaseView({ event: 'progress-nudge', pattern: 'monologue' })).toBeNull();
    expect(movingBaseView(null)).toBeNull();
    expect(movingBaseView(undefined)).toBeNull();
  });

  it('stays quiet with no count while the retries are far from the bound', () => {
    expect(movingBaseView({ event: 'moving-base', attempt: 1, of: 5 })).toEqual({
      label: 'Reconciling with the latest base…',
      count: null,
      nearBound: false,
    });
  });

  it('surfaces the count and raises prominence only within one of the bound', () => {
    expect(movingBaseView({ event: 'moving-base', attempt: 4, of: 5 })).toEqual({
      label: 'Reconciling with the latest base…',
      count: '4/5',
      nearBound: true,
    });
    expect(movingBaseView({ event: 'moving-base', attempt: 5, of: 5 })).toEqual({
      label: 'Reconciling with the latest base…',
      count: '5/5',
      nearBound: true,
    });
  });
});

describe('coalesceTail', () => {
  const perm = (id: number): RunEvent => evt(id, 'permission_request', { request: {}, outcome: {} });

  it('coalesces the whole array and hides nothing when under the cap', () => {
    const events = [perm(1), perm(2), perm(3)];
    expect(coalesceTail(events, 10)).toEqual({ hidden: 0, items: coalesceEvents(events) });
  });

  it('caps to the most recent events, reporting how many were hidden', () => {
    const events = [perm(1), perm(2), perm(3), perm(4), perm(5)];
    const { hidden, items } = coalesceTail(events, 2);
    expect(hidden).toBe(3);
    // Order preserved, only the ancient head dropped — the last two survive.
    expect(items.map((i) => i.key)).toEqual([4, 5]);
  });

  it('folds within the tail exactly as coalesceEvents does over that slice', () => {
    const events = [chunk(1, 'old'), chunk(2, 'ancient'), chunk(3, 'live '), chunk(4, 'tail')];
    const { items } = coalesceTail(events, 2);
    expect(items).toEqual(coalesceEvents(events.slice(2)));
    expect(items).toEqual([{ kind: 'text', variant: 'message', text: 'live tail', key: 3 }]);
  });

  it('bounds a multi-thousand-event run to the cap without reordering', () => {
    const events = Array.from({ length: 5000 }, (_, i) => perm(i + 1));
    const { hidden, items } = coalesceTail(events);
    expect(hidden).toBe(5000 - MAX_STREAM_EVENTS);
    expect(items.length).toBe(MAX_STREAM_EVENTS);
    expect(items.map((i) => i.key)).toEqual(Array.from({ length: MAX_STREAM_EVENTS }, (_, i) => hidden + 1 + i));
  });

  it('defaults the cap to MAX_STREAM_EVENTS', () => {
    const events = Array.from({ length: MAX_STREAM_EVENTS + 1 }, (_, i) => perm(i + 1));
    expect(coalesceTail(events).hidden).toBe(1);
  });

  it('renders a degraded-but-intact tool row when the opening tool_call aged out of the tail', () => {
    // A long-running tool whose `tool_call` fell before the cut: only its later
    // `tool_call_update` (status-only) survives, so title/kind can't be merged
    // back. The row must still render safely — ToolLine falls back to
    // 'Tool call'/'tool' — not vanish or crash. Bounded fidelity, never loss.
    const call = evt(1, 'session_update', {
      sessionUpdate: 'tool_call',
      toolCallId: 't',
      kind: 'read',
      title: 'big.log',
      status: 'pending',
    });
    const update = evt(2, 'session_update', { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' });
    const { hidden, items } = coalesceTail([call, update], 1);
    expect(hidden).toBe(1);
    expect(items).toEqual([
      {
        kind: 'tool',
        tool: { toolCallId: 't', toolKind: undefined, title: undefined, status: 'completed', subagent: false },
        key: 2,
      },
    ]);
  });
});
