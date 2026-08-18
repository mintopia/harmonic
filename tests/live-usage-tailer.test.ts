import { describe, it, expect, vi, afterEach } from 'vitest';
import { LiveUsageTailer } from '../src/execution/live-usage-tailer.js';
import { activityLine, type RunUsageSnapshot } from '../src/execution/usage.js';
import { currentTurnEvents } from '../src/domain/replay-quarantine.js';
import type { QuarantinableEvent } from '../src/domain/replay-quarantine.js';

const snap = (activity: string | null): RunUsageSnapshot => ({
  usage: { models: {}, totals: null, toolCalls: {}, source: 'session-log' },
  contextTokens: null,
  activity,
  tree: { id: 'r', name: 'root', model: 'unknown', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: null, status: 'active', depth: 0, toolUseId: null, children: [] },
});

describe('LiveUsageTailer cadence (ADR 0010)', () => {
  afterEach(() => vi.useRealTimers());

  it('pushes ~1s (coalesced) but persists only ~10s, and dedupes unchanged snapshots', () => {
    vi.useFakeTimers();
    let current = snap('one');
    const emit = vi.fn();
    const persist = vi.fn();
    const tailer = new LiveUsageTailer(
      { sample: () => current, emit, persist },
      { pushMs: 1000, persistMs: 10_000 },
    );
    tailer.start(1);

    // Nine 1s ticks with no change: one emit (first), the rest deduped; no persist yet.
    vi.advanceTimersByTime(9_000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();

    // A change re-emits; the 10th tick also crosses the persist threshold.
    current = snap('two');
    vi.advanceTimersByTime(1_000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('flushes emit + persist unconditionally on stop, then goes quiet', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const persist = vi.fn();
    const tailer = new LiveUsageTailer({ sample: () => snap('done'), emit, persist }, { pushMs: 1000, persistMs: 10_000 });
    tailer.start(1);
    tailer.stop(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    // The interval is cleared — further time advances nothing.
    vi.advanceTimersByTime(60_000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('emits nothing while the log has no snapshot yet', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const persist = vi.fn();
    const tailer = new LiveUsageTailer({ sample: () => null, emit, persist }, { pushMs: 1000, persistMs: 10_000 });
    tailer.start(1);
    vi.advanceTimersByTime(30_000);
    tailer.stop(1);
    expect(emit).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
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
    // Replayed tail with nothing live: the current-turn activity is empty.
    const replayedTail: QuarantinableEvent[] = [
      update({ title: 'Edit', replay: true }),
      update({ title: 'Write', replay: true }),
    ];
    const noLive = currentTurnEvents(replayedTail);
    expect(noLive).toEqual([]);

    // A live update present: currentTurnEvents keeps it (in order), and the
    // activity line a tailer would show comes from it — never the replayed tail.
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

  // AC5, at the live-usage-tailer seam: a tailer whose sampler quarantines
  // replay (as the runner's does — building activity/usage from currentTurnEvents
  // only) emits a snapshot with zero replay-derived activity/usage, even when the
  // whole event log is load-time replay.
  it('the tailer emits a quarantined snapshot: zero current-turn usage/activity from an all-replay log', () => {
    vi.useFakeTimers();
    // A sampler mirroring the runner: derive the snapshot from current-turn
    // events only, so replayed history contributes nothing.
    const sampleFromLog = (log: QuarantinableEvent[]): RunUsageSnapshot => {
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
      { sample: () => sampleFromLog(allReplay), emit, persist },
      { pushMs: 1000, persistMs: 10_000 },
    );
    tailer.start(1);
    tailer.stop(1);

    expect(emit).toHaveBeenCalledTimes(1);
    const snapshot = emit.mock.calls[0]![1] as RunUsageSnapshot;
    expect(snapshot.activity).toBeNull();
    expect(snapshot.usage.toolCalls).toEqual({});
  });
});
