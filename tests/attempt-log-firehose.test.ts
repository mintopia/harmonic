import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttemptRow } from '../src/db/schema.js';
import { EventBus } from '../src/server/bus.js';
import type { LiveAttemptEvent } from '../src/execution/runner.js';

const event = (seq: number): LiveAttemptEvent => ({
  id: 1_000_000_000 + seq,
  attemptId: 42,
  seq,
  ts: seq,
  type: 'session_update',
  payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(seq) } },
});

describe('run log firehose', () => {
  it('replays every missed update for an in-progress run in order', () => {
    const bus = new EventBus();
    for (let seq = 1; seq <= 2_001; seq += 1) bus.emitAttemptLog(event(seq));

    expect([...bus.replayAttemptLog({ attemptId: 42, after: 0 })].map((update) => update.seq)).toEqual(
      Array.from({ length: 2_001 }, (_, index) => index + 1),
    );
  });

  describe('buffer release', () => {
    afterEach(() => vi.useRealTimers());

    it('frees the builder and critic buffers shortly after the Attempt ends', () => {
      vi.useFakeTimers();
      const bus = new EventBus(1_000);
      bus.emitAttemptLog(event(1));
      bus.emitCriticLog(event(1));
      bus.emit('attempt_changed', { id: 42, endedAt: null } as AttemptRow);
      vi.advanceTimersByTime(5_000);
      expect([...bus.replayAttemptLog({ attemptId: 42, after: 0 })]).toHaveLength(1);

      bus.emit('attempt_changed', { id: 42, endedAt: 1 } as AttemptRow);
      vi.advanceTimersByTime(999);
      expect([...bus.replayAttemptLog({ attemptId: 42, after: 0 })]).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect([...bus.replayAttemptLog({ attemptId: 42, after: 0 })]).toEqual([]);
      expect([...bus.replayCriticLog({ attemptId: 42, after: 0 })]).toEqual([]);
      expect(bus.latestAttemptLogSeq({ attemptId: 42 })).toBe(0);
    });
  });
});
