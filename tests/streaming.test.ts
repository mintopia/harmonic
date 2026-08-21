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

describe('live structured run event streaming and replay', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('keeps the ACP stream out of WebSocket events and replay', async () => {
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

    // A native Run parks non-terminal in `phase:'review'` at agent-finish
    // (issue #114) — it stays `state:'running'`, so "done executing" is the
    // run_changed that carries the review phase, not a non-running state.
    await waitFor(async () =>
      ws.messages.some((m) => m.type === 'run_changed' && m.run.id === runId && m.run.phase === 'review'),
    );

    const streamed = ws.messages.filter(
      (m) => m.type === 'run_event' && m.event.runId === runId && m.event.type === 'session_update',
    );
    expect(streamed).toEqual([]);

    const replay = await server.api('GET', `/api/runs/${runId}/events`);
    const replayUpdates = replay.body.events.filter((e: any) => e.type === 'session_update');
    expect(replayUpdates).toEqual([]);

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

  it('task_changed payloads carry the API task shape, identical to REST', async () => {
    const ws = await connectWs(server);
    const dep = await server.api('POST', '/api/tasks', { prompt: 'dependency', state: 'draft' });
    const created = await server.api('POST', '/api/tasks', {
      prompt: 'dependent',
      dependsOn: [dep.body.id],
    });

    await waitFor(async () =>
      ws.messages.some((m) => m.type === 'task_changed' && m.task.id === created.body.id),
    );
    const msg = ws.messages.find((m) => m.type === 'task_changed' && m.task.id === created.body.id);

    // The board renders dependsOn/blockedOnFailed straight off WS payloads;
    // a bare row here blank-pages the SPA (issue 15).
    expect(msg.task.dependsOn).toEqual([dep.body.id]);
    expect(msg.task.dependents).toEqual([]);
    expect(msg.task.blockedOnFailed).toBe(false);

    const rest = await server.api('GET', `/api/tasks/${created.body.id}`);
    expect(msg.task).toEqual(rest.body);
    ws.close();
  });
});
