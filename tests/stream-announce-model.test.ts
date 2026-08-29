import { describe, expect, it } from 'vitest';
import { coalesceEvents } from '../web/src/event-stream-model.js';
import {
  announceTransitions,
  EMPTY_ANNOUNCE_CURSOR,
} from '../web/src/stream-announce-model.js';
import type { RunEvent } from '../web/src/types.js';

const evt = (id: number, type: RunEvent['type'], payload: any): RunEvent => ({
  id,
  attemptId: 1,
  seq: id,
  ts: id,
  type,
  payload,
});

const chunk = (id: number, text: string, sessionUpdate = 'agent_message_chunk'): RunEvent =>
  evt(id, 'session_update', { sessionUpdate, content: { type: 'text', text } });

const tool = (id: number, toolCallId: string, status: string, title = 'Read src/x.ts'): RunEvent =>
  evt(id, 'session_update', { sessionUpdate: 'tool_call', toolCallId, kind: 'read', title, status });

const toolUpdate = (id: number, toolCallId: string, status: string): RunEvent =>
  evt(id, 'session_update', { sessionUpdate: 'tool_call_update', toolCallId, status });

const lifecycle = (id: number, payload: any): RunEvent => evt(id, 'lifecycle', payload);

/** The whole pipeline the component runs: raw events → coalesced items →
 * announcements, given a starting cursor. */
const announce = (events: RunEvent[], cursor = EMPTY_ANNOUNCE_CURSOR) =>
  announceTransitions(coalesceEvents(events), cursor);

describe('announceTransitions — transcript transitions for a polite live region', () => {
  it('announces a fresh agent message once, not per streamed chunk', () => {
    // The exact byte-boundary splits coalescing folds into one utterance.
    const { announcements } = announce([chunk(1, 'I searched the de'), chunk(2, 'ferred list.')]);
    expect(announcements).toEqual(['New message']);
  });

  it('does not announce agent thoughts — only messages the operator receives', () => {
    const { announcements } = announce([chunk(1, 'pondering', 'agent_thought_chunk')]);
    expect(announcements).toEqual([]);
  });

  it('announces a tool completing, but stays silent while it is still running', () => {
    const running = announce([tool(1, 'a', 'pending')]);
    expect(running.announcements).toEqual([]);

    const done = announce([tool(1, 'a', 'pending'), toolUpdate(2, 'a', 'completed')]);
    expect(done.announcements).toEqual(['Read src/x.ts completed']);
  });

  it('announces a tool failing with its title', () => {
    const { announcements } = announce([tool(1, 'a', 'failed', 'Edit config.ts')]);
    expect(announcements).toEqual(['Edit config.ts failed']);
  });

  it('falls back to "Tool call" when a terminal tool has no title', () => {
    const untitled = evt(1, 'session_update', {
      sessionUpdate: 'tool_call',
      toolCallId: 'a',
      status: 'completed',
    });
    expect(announce([untitled]).announcements).toEqual(['Tool call completed']);
  });

  it('speaks a Turn finishing, interrupting, erroring, and timing out', () => {
    expect(announce([lifecycle(1, { event: 'finished' })]).announcements).toEqual(['Turn finished']);
    expect(
      announce([lifecycle(1, { event: 'finished', stopReason: 'cancelled' })]).announcements,
    ).toEqual(['Turn interrupted']);
    expect(announce([lifecycle(1, { event: 'error', message: 'boom' })]).announcements).toEqual([
      'Turn ended with an error',
    ]);
    expect(announce([lifecycle(1, { event: 'idle_timeout' })]).announcements).toEqual([
      'Turn timed out',
    ]);
  });

  it('ignores lifecycle bookkeeping that is not a Turn ending', () => {
    const noise = [
      lifecycle(1, { event: 'mode_set', mode: 'auto' }),
      lifecycle(2, { event: 'steer_queued', text: 'hi' }),
      lifecycle(3, { event: 'continue', attempt: 2 }),
    ];
    expect(announce(noise).announcements).toEqual([]);
  });

  it('is idempotent: re-deriving with the returned cursor announces nothing new', () => {
    const events = [chunk(1, 'hello'), tool(2, 'a', 'completed'), lifecycle(3, { event: 'finished' })];
    const first = announce(events);
    expect(first.announcements).toEqual(['New message', 'Read src/x.ts completed', 'Turn finished']);

    // Same items, carried cursor → nothing, and the same cursor reference so a
    // caller can skip the re-render.
    const second = announceTransitions(coalesceEvents(events), first.cursor);
    expect(second.announcements).toEqual([]);
    expect(second.cursor).toBe(first.cursor);
  });

  it('only speaks the delta as a stream grows across renders', () => {
    // Render 1: a message begins, a tool is still running.
    const r1 = announce([chunk(1, 'On it. '), tool(2, 'a', 'pending')]);
    expect(r1.announcements).toEqual(['New message']);

    // Render 2: more of the SAME message arrives (no re-announce) and the tool
    // finishes (new). The message item keeps key 1, so it is not spoken again.
    const r2 = announceTransitions(
      coalesceEvents([chunk(1, 'On it. '), chunk(3, 'Done.'), tool(2, 'a', 'pending'), toolUpdate(4, 'a', 'completed')]),
      r1.cursor,
    );
    expect(r2.announcements).toEqual(['Read src/x.ts completed']);
  });

  it('seeding a backlog marks it seen without announcing, then speaks only what merges after', () => {
    const backlog = [chunk(1, 'old reply'), tool(2, 'a', 'completed'), lifecycle(3, { event: 'finished' })];
    // Seed: discard announcements, keep the cursor (what the component does on
    // opening a conversation with history).
    const seeded = announce(backlog).cursor;

    const live = announceTransitions(
      coalesceEvents([...backlog, chunk(4, 'new reply')]),
      seeded,
    );
    expect(live.announcements).toEqual(['New message']);
  });

  it('announces two separate messages in one turn as two distinct transitions', () => {
    // A tool between them splits the coalesced text into two message items with
    // distinct keys — both are genuinely new utterances and both are spoken.
    const events = [chunk(1, 'first'), tool(2, 'a', 'completed'), chunk(3, 'second')];
    expect(announce(events).announcements).toEqual([
      'New message',
      'Read src/x.ts completed',
      'New message',
    ]);
  });
});
