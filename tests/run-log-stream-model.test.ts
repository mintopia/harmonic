import { describe, expect, it } from 'vitest';
import { appendRunLogEvents, runLogCursor } from '../web/src/run-log-stream-model.js';

const event = (id: number) => ({
  id,
  seq: id,
  ts: id,
  type: 'session_update' as const,
  payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(id) } },
});

describe('appendRunLogEvents', () => {
  it('keeps hydrated terminal logs intact when there are no live events', () => {
    expect(appendRunLogEvents([event(1), event(2)], [])).toEqual([event(1), event(2)]);
  });

  it('appends each live event after hydration in arrival order', () => {
    expect(appendRunLogEvents([event(1)], [event(1_000_000_001), event(1_000_000_002)])).toEqual([
      event(1),
      event(1_000_000_001),
      event(1_000_000_002),
    ]);
  });

  it('drops a replayed firehose event after reconnect without dropping later output', () => {
    expect(appendRunLogEvents([event(1), event(1_000_000_001)], [event(1_000_000_001), event(1_000_000_002)])).toEqual([
      event(1),
      event(1_000_000_001),
      event(1_000_000_002),
    ]);
  });

  it('sets the reconnect cursor from the latest hydrated or buffered event', () => {
    expect(runLogCursor([event(1), event(2), event(1_000_000_003)])).toBe(1_000_000_003);
    expect(runLogCursor([])).toBe(0);
  });

});
