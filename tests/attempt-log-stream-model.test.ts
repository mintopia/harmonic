import { describe, expect, it } from 'vitest';
import { appendAttemptLogEvents, eventsAfterLiveCursor, attemptLogCursor } from '../web/src/attempt-log-stream-model.js';

const event = (id: number) => ({
  id,
  seq: id,
  ts: id,
  type: 'session_update' as const,
  payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(id) } },
});

describe('appendAttemptLogEvents', () => {
  it('keeps hydrated terminal logs intact when there are no live events', () => {
    expect(appendAttemptLogEvents({ current: [event(1), event(2)], additions: [] })).toEqual([event(1), event(2)]);
  });

  it('appends each live event after hydration in arrival order', () => {
    expect(appendAttemptLogEvents({ current: [event(1)], additions: [event(1_000_000_001), event(1_000_000_002)] })).toEqual([
      event(1),
      event(1_000_000_001),
      event(1_000_000_002),
    ]);
  });

  it('drops a replayed firehose event after reconnect without dropping later output', () => {
    expect(appendAttemptLogEvents({ current: [event(1), event(1_000_000_001)], additions: [event(1_000_000_001), event(1_000_000_002)] })).toEqual([
      event(1),
      event(1_000_000_001),
      event(1_000_000_002),
    ]);
  });

  it('sets the reconnect cursor from the latest hydrated or buffered event', () => {
    expect(attemptLogCursor({ events: [{ ...event(1_000_000_003), attemptId: 1 }, event(1), event(2)] })).toBe(1_000_000_003);
    expect(attemptLogCursor({ events: [] })).toBe(0);
  });

  it('only appends live updates emitted after the REST snapshot cutover', () => {
    expect(eventsAfterLiveCursor({ events: [{ ...event(1), attemptId: 1 }, { ...event(2), attemptId: 1 }, { ...event(3), attemptId: 1 }], liveCursor: 2 })).toEqual([
      { ...event(3), attemptId: 1 },
    ]);
  });

});
