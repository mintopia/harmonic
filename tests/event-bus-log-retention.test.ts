import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../src/server/bus.js';
import type { AttemptRow } from '../src/db/schema.js';

const logEvent = (attemptId: number, seq: number) => ({
  id: seq, attemptId, seq, ts: 0, type: 'session_update' as const, payload: { sessionUpdate: 'agent_message_chunk' },
});
const ended = { id: 7, endedAt: 1 } as AttemptRow;

describe('EventBus replay-buffer retention (#858)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('clears both buffers once an ended Attempt has been quiet for the retention window', () => {
    const bus = new EventBus(1_000);
    bus.emitAttemptLog(logEvent(7, 1));
    bus.emitCriticLog(logEvent(7, 1));
    bus.emit('attempt_changed', ended);
    vi.advanceTimersByTime(1_001);
    expect([...bus.replayAttemptLog({ attemptId: 7, after: 0 })]).toEqual([]);
    expect([...bus.replayCriticLog({ attemptId: 7, after: 0 })]).toEqual([]);
  });

  it('keeps the critic buffer while a critic still streams after the Attempt ended', () => {
    const bus = new EventBus(1_000);
    bus.emit('attempt_changed', ended);
    for (let seq = 1; seq <= 4; seq++) {
      vi.advanceTimersByTime(700);
      bus.emitCriticLog(logEvent(7, seq));
    }
    expect([...bus.replayCriticLog({ attemptId: 7, after: 0 })].map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    vi.advanceTimersByTime(1_001);
    expect([...bus.replayCriticLog({ attemptId: 7, after: 0 })]).toEqual([]);
  });

  it('keeps buffers when the Attempt is re-opened', () => {
    const bus = new EventBus(1_000);
    bus.emitCriticLog(logEvent(7, 1));
    bus.emit('attempt_changed', ended);
    bus.emit('attempt_changed', { id: 7, endedAt: null } as AttemptRow);
    vi.advanceTimersByTime(5_000);
    expect([...bus.replayCriticLog({ attemptId: 7, after: 0 })]).toHaveLength(1);
  });
});
