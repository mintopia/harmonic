import { describe, it, expect, vi, afterEach } from 'vitest';
import { LiveUsageTailer } from '../src/execution/live-usage-tailer.js';
import { activityLine, type RunUsageSnapshot } from '../src/execution/usage.js';

const snap = (activity: string | null): RunUsageSnapshot => ({
  usage: { models: {}, totals: null, toolCalls: {}, source: 'session-log' },
  contextTokens: null,
  activity,
  tree: { id: 'r', name: 'root', model: 'unknown', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: null, status: 'active', depth: 0, children: [] },
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
