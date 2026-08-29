import { describe, expect, it } from 'vitest';
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
});
