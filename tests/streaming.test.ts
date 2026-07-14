import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

/** Collect WS messages into an inspectable list. */
async function connectWs(server: TestServer): Promise<{ messages: any[]; close: () => void }> {
  const ws = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/ws?token=${server.sessionToken}`);
  const messages: any[] = [];
  ws.addEventListener('message', (ev) => messages.push(JSON.parse(String(ev.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return { messages, close: () => ws.close() };
}

describe('live run event streaming and replay', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('broadcasts run events over WebSocket in order, live while the task is still running', async () => {
    const updates = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'pending' },
      { sessionUpdate: 'plan', entries: [{ content: 'step', status: 'pending', priority: 'medium' }] },
    ];
    const ws = await connectWs(server);

    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ updates, delayMs: 40 }),
    });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    const runId = started.body.id;

    // First event arrives while the task is still running — that's "live".
    await waitFor(async () => ws.messages.some((m) => m.type === 'run_event' && m.event.runId === runId));
    const taskMidRun = await server.api('GET', `/api/tasks/${created.body.id}`);
    expect(taskMidRun.body.state).toBe('running');

    await waitFor(async () =>
      ws.messages.some((m) => m.type === 'run_changed' && m.run.id === runId && m.run.state !== 'running'),
    );

    const streamed = ws.messages
      .filter((m) => m.type === 'run_event' && m.event.runId === runId && m.event.type === 'session_update')
      .map((m) => m.event);
    expect(streamed.map((e) => e.payload.sessionUpdate)).toEqual([
      'agent_message_chunk',
      'agent_thought_chunk',
      'tool_call',
      'plan',
    ]);
    expect(streamed.map((e) => e.seq)).toEqual([...streamed.map((e) => e.seq)].sort((a, b) => a - b));

    // Replay renders from the same persisted records: the REST event list
    // must equal what was streamed.
    const replay = await server.api('GET', `/api/runs/${runId}/events`);
    const replayUpdates = replay.body.events.filter((e: any) => e.type === 'session_update');
    expect(replayUpdates).toEqual(streamed);

    ws.close();
  });

  it('broadcasts task state changes so the board updates without polling', async () => {
    const ws = await connectWs(server);
    const created = await server.api('POST', '/api/tasks', { prompt: 'plain prompt' });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);

    await waitFor(async () =>
      ws.messages.some(
        (m) => m.type === 'task_changed' && m.task.id === created.body.id && m.task.state === 'awaiting-review',
      ),
    );
    ws.close();
  });
});
