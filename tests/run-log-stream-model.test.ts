import { describe, expect, it } from 'vitest';
import { appendRunLogEvents, eventsAfterLiveCursor, runLogCursor } from '../web/src/run-log-stream-model.js';

const event = (id: number) => ({
  id,
  seq: id,
  ts: id,
  type: 'session_update' as const,
  payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(id) } },
});

describe('appendRunLogEvents', () => {
  it('keeps hydrated terminal logs intact when there are no live events', () => {
    expect(appendRunLogEvents({ current: [event(1), event(2)], additions: [] })).toEqual([event(1), event(2)]);
  });

  it('appends each live event after hydration in arrival order', () => {
    expect(appendRunLogEvents({ current: [event(1)], additions: [event(1_000_000_001), event(1_000_000_002)] })).toEqual([
      event(1),
      event(1_000_000_001),
      event(1_000_000_002),
    ]);
  });

  it('drops a replayed firehose event after reconnect without dropping later output', () => {
    expect(appendRunLogEvents({ current: [event(1), event(1_000_000_001)], additions: [event(1_000_000_001), event(1_000_000_002)] })).toEqual([
      event(1),
      event(1_000_000_001),
      event(1_000_000_002),
    ]);
  });

  it('sets the reconnect cursor from the latest hydrated or buffered event', () => {
    expect(runLogCursor({ events: [{ ...event(1_000_000_003), runId: 1 }, event(1), event(2)] })).toBe(1_000_000_003);
    expect(runLogCursor({ events: [] })).toBe(0);
  });

  it('only appends live updates emitted after the REST snapshot cutover', () => {
    expect(eventsAfterLiveCursor({ events: [{ ...event(1), runId: 1 }, { ...event(2), runId: 1 }, { ...event(3), runId: 1 }], liveCursor: 2 })).toEqual([
      { ...event(3), runId: 1 },
    ]);
  });

});
