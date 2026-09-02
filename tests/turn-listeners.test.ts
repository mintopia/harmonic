import { describe, expect, it } from 'vitest';
import { TurnListeners, TurnState } from '../src/execution/runner.js';
import type { AttemptRow } from '../src/db/schema.js';

describe('TurnListeners', () => {
  it('keeps session initialization and permission decisions inside one turn', async () => {
    const state = new TurnState({} as AttemptRow, new Map(), []);
    const records: unknown[] = [];
    const liveEvents: unknown[] = [];
    const listeners = new TurnListeners({
      task: { harness: 'claude' } as never,
      run: { id: 42 } as never,
      state,
      autoDriven: false,
      events: { onAttemptLogEvent: (event) => liveEvents.push(event) },
      record: (_type, payload) => records.push(payload),
      nextProgressSequence: () => 1,
      outstandingAction: () => {},
      completeOutstandingAction: () => {},
    });

    listeners.onInitialize({ protocolVersion: 1 } as never);
    listeners.onSessionUpdate({ sessionUpdate: 'tool_call', title: 'Read', kind: 'read' }, false);
    listeners.onSessionUpdate({ sessionUpdate: 'tool_call', title: 'Write', kind: 'write' }, true);
    const response = await listeners.onRequest('session/request_permission', {
      options: [
        { kind: 'allow_once', optionId: 'once' },
        { kind: 'allow_always', optionId: 'always' },
      ],
    });

    expect(state.sessionInit).toMatchObject({ protocolVersion: 1 });
    expect(state.toolCalls).toEqual(new Map([['Read', 1]]));
    expect(liveEvents).toHaveLength(1);
    expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } });
    expect(records).toEqual([
      {
        request: {
          options: [
            { kind: 'allow_once', optionId: 'once' },
            { kind: 'allow_always', optionId: 'always' },
          ],
        },
        outcome: { outcome: 'selected', optionId: 'always' },
      },
    ]);
  });
});
