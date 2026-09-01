import { describe, expect, it } from 'vitest';
import { transcriptLanes } from '../web/src/transcript-timeline-model.js';
import type { AttemptLogEvent } from '../web/src/types.js';

const event = (id: number, payload: Record<string, unknown>): AttemptLogEvent => ({
  id,
  seq: id,
  ts: id,
  type: 'session_update',
  payload: { sessionUpdate: 'agent_message_chunk', ...payload },
});

describe('transcriptLanes', () => {
  it('keeps root events together and groups a subagent under its spawning Agent call', () => {
    const parentId = 'toolu_agent';
    const events = [
      event(1, { content: { type: 'text', text: 'I will delegate.' } }),
      event(2, { sessionUpdate: 'tool_call', toolCallId: parentId, kind: 'Agent', title: 'Explore the transcript model' }),
      event(3, {
        content: { type: 'text', text: 'I found the relevant code.' },
        _meta: { claudeCode: { parentToolUseId: parentId } },
      }),
      event(4, { content: { type: 'text', text: 'I will implement it.' } }),
    ];

    expect(transcriptLanes(events)).toEqual([
      { id: 'main', label: 'Main agent', events: [events[0], events[1], events[3]] },
      { id: parentId, label: 'Explore the transcript model', events: [events[2]] },
    ]);
  });

  it('uses a graceful fallback when the spawning call is absent and keeps unattributed events flat', () => {
    const events = [
      event(1, { content: { type: 'text', text: 'Main stream.' } }),
      event(2, {
        content: { type: 'text', text: 'Detached child stream.' },
        _meta: { claudeCode: { parentToolUseId: 'missing-parent' } },
      }),
    ];

    expect(transcriptLanes(events)).toEqual([
      { id: 'main', label: 'Main agent', events: [events[0]] },
      { id: 'missing-parent', label: 'Subagent', events: [events[1]] },
    ]);
  });

  it('keeps interleaved Agent and Task streams separate before their text can coalesce', () => {
    const agent = 'toolu_agent';
    const task = 'toolu_task';
    const events = [
      event(1, { sessionUpdate: 'tool_call', toolCallId: agent, kind: 'Agent', title: 'Find tests' }),
      event(2, { sessionUpdate: 'tool_call', toolCallId: task, kind: 'Task', title: 'Implement model' }),
      event(3, { content: { type: 'text', text: 'First' }, _meta: { claudeCode: { parentToolUseId: agent } } }),
      event(4, { content: { type: 'text', text: 'Second' }, _meta: { claudeCode: { parentToolUseId: task } } }),
      event(5, { content: { type: 'text', text: ' again' }, _meta: { claudeCode: { parentToolUseId: agent } } }),
    ];

    const lanes = transcriptLanes(events);
    expect(lanes.map(({ id, label, events: laneEvents }) => ({ id, label, ids: laneEvents.map((item) => item.id) }))).toEqual([
      { id: 'main', label: 'Main agent', ids: [1, 2] },
      { id: agent, label: 'Find tests', ids: [3, 5] },
      { id: task, label: 'Implement model', ids: [4] },
    ]);
  });

  it('treats malformed attribution as an ordinary main-agent event', () => {
    const events = [event(1, { _meta: { claudeCode: { parentToolUseId: 42 } } })];
    expect(transcriptLanes(events)).toEqual([{ id: 'main', label: 'Main agent', events }]);
  });
});
