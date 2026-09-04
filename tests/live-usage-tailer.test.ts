import { describe, it, expect, vi, afterEach } from 'vitest';
import { LiveUsageTailer } from '../src/execution/live-usage-tailer.js';
import { activityLine, type AttemptUsageSnapshot } from '../src/execution/usage.js';
import { currentTurnEvents } from '../src/domain/replay-quarantine.js';
import type { QuarantinableEvent } from '../src/domain/replay-quarantine.js';

const snap = (activity: string | null): AttemptUsageSnapshot => ({
  usage: { models: {}, totals: null, toolCalls: {}, source: 'session-log' },
  contextTokens: null,
  activity,
  tree: { id: 'r', name: 'root', model: 'unknown', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: null, lastTool: null, status: 'active', depth: 0, toolUseId: null, children: [] },
});

describe('LiveUsageTailer cadence (ADR 0010)', () => {
  afterEach(() => vi.useRealTimers());

  it('pushes ~1s (coalesced) but persists only ~10s, and dedupes unchanged snapshots', async () => {
    vi.useFakeTimers();
    let current = snap('one');
    const emit = vi.fn();
    const persist = vi.fn();
    const tailer = new LiveUsageTailer(
      { sample: async () => current, emit, persist },
      { pushMs: 1000, persistMs: 10_000 },
    );
    tailer.start(1);

    await vi.advanceTimersByTimeAsync(9_000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();

    current = snap('two');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('flushes emit + persist unconditionally on stop, then goes quiet', async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const persist = vi.fn();
    const tailer = new LiveUsageTailer({ sample: async () => snap('done'), emit, persist }, { pushMs: 1000, persistMs: 10_000 });
    tailer.start(1);
    await tailer.stop(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('emits nothing while the log has no snapshot yet', async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const persist = vi.fn();
    const tailer = new LiveUsageTailer({ sample: async () => null, emit, persist }, { pushMs: 1000, persistMs: 10_000 });
    tailer.start(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await tailer.stop(1);
    expect(emit).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('skips a fire while a slow sample is still in flight — never overlaps reads on one cursor', async () => {
    vi.useFakeTimers();
    let resolve!: (s: AttemptUsageSnapshot) => void;
    let calls = 0;
    const sample = vi.fn(() => {
      calls++;
      return new Promise<AttemptUsageSnapshot>((r) => (resolve = r));
    });
    const tailer = new LiveUsageTailer({ sample, emit: vi.fn(), persist: vi.fn() }, { pushMs: 1000, persistMs: 10_000 });
    tailer.start(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(1);
    resolve(snap('one'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
  });
});

describe('activityLine', () => {
  it('reads a tool call title, falling back to kind', () => {
    expect(activityLine({ sessionUpdate: 'tool_call', title: 'Edit', kind: 'edit' })).toBe('Edit');
    expect(activityLine({ sessionUpdate: 'tool_call_update', kind: 'read' })).toBe('read');
  });

  it('reads the first non-empty line of an assistant message', () => {
    expect(activityLine({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n  Writing the runner\nmore' } }))
      .toBe('Writing the runner');
  });

  it('is null for non-activity updates, so the caller keeps the last line', () => {
    expect(activityLine({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } })).toBeNull();
    expect(activityLine({ sessionUpdate: 'plan', entries: [] })).toBeNull();
    expect(activityLine(undefined)).toBeNull();
  });
});

describe('replay quarantine at the live-usage boundary (issue #144)', () => {
  const update = (over: Partial<QuarantinableEvent> & { title: string }): QuarantinableEvent => ({
    type: 'session_update',
    payload: { sessionUpdate: 'tool_call', title: over.title, kind: 'edit' },
    ...over,
  });

  it('a run event log that is entirely load-time replay reduces to zero current-turn events', () => {
    const allReplay: QuarantinableEvent[] = [
      update({ title: 'Edit', replay: true }),
      update({ title: 'Write', replay: true }),
      update({ title: 'Read', replay: true }),
    ];

    expect(currentTurnEvents(allReplay)).toEqual([]);
  });

  it('currentTurnEvents keeps only live events in order, so activityLine on the last one shows only current-turn activity', () => {
    const replayedTail: QuarantinableEvent[] = [
      update({ title: 'Edit', replay: true }),
      update({ title: 'Write', replay: true }),
    ];
    const noLive = currentTurnEvents(replayedTail);
    expect(noLive).toEqual([]);

    const mixed: QuarantinableEvent[] = [
      update({ title: 'Edit', replay: true }),
      update({ title: 'Write', replay: true }),
      update({ title: 'Bash', replay: false }),
    ];
    const live = currentTurnEvents(mixed);
    expect(live).toEqual([mixed[2]]);
    const lastLive = live[live.length - 1]!;
    expect(activityLine(lastLive.payload)).toBe('Bash');
  });

  it('the tailer emits a quarantined snapshot: zero current-turn usage/activity from an all-replay log', async () => {
    vi.useFakeTimers();
    const sampleFromLog = (log: QuarantinableEvent[]): AttemptUsageSnapshot => {
      const current = currentTurnEvents(log);
      const lastActivity = [...current].reverse().map((e) => activityLine(e.payload)).find((l) => l !== null) ?? null;
      const toolCalls = current.filter(
        (e) => e.type === 'session_update' && (e.payload as any)?.sessionUpdate === 'tool_call',
      ).length;
      return { ...snap(lastActivity), usage: { ...snap(null).usage, toolCalls: toolCalls ? { tool: toolCalls } : {} } };
    };

    const allReplay: QuarantinableEvent[] = [
      update({ title: 'Edit', replay: true }),
      update({ title: 'Write', replay: true }),
    ];
    const emit = vi.fn();
    const persist = vi.fn();
    const tailer = new LiveUsageTailer(
      { sample: async () => sampleFromLog(allReplay), emit, persist },
      { pushMs: 1000, persistMs: 10_000 },
    );
    tailer.start(1);
    await tailer.stop(1);

    expect(emit).toHaveBeenCalledTimes(1);
    const snapshot = emit.mock.calls[0]![1] as AttemptUsageSnapshot;
    expect(snapshot.activity).toBeNull();
    expect(snapshot.usage.toolCalls).toEqual({});
  });
});
