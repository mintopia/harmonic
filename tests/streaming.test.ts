import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

/** Collect WS messages into an inspectable list. */
async function connectWs(server: TestServer): Promise<{ messages: any[]; send: (message: unknown) => void; close: () => void }> {
  const ws = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/ws?token=${server.sessionToken}`);
  const messages: any[] = [];
  ws.addEventListener('message', (ev) => messages.push(JSON.parse(String(ev.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return { messages, send: (message) => ws.send(JSON.stringify(message)), close: () => ws.close() };
}

describe('live structured run event streaming and replay', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('streams ACP updates without persisting them for REST replay', async () => {
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
    // The log firehose is opt-in and cursor-resumable, unlike global board
    // events. Start at zero to receive this Run's complete live stream.
    ws.send({ type: 'run_log_subscribe', runId, after: 0 });

    // A native Run parks non-terminal in `phase:'review'` at agent-finish
    // (issue #114) — it stays `state:'running'`, so "done executing" is the
    // run_changed that carries the review phase, not a non-running state.
    await waitFor(async () =>
      ws.messages.some((m) => m.type === 'run_changed' && m.run.id === runId && m.run.phase === 'terminal'),
    );

    const streamed = ws.messages.filter(
      (m) => m.type === 'run_log_event' && m.event.runId === runId && m.event.type === 'session_update',
    );
    expect(streamed.map((m) => m.event.payload.sessionUpdate)).toEqual(updates.map((update) => update.sessionUpdate));
    expect(streamed.map((m) => m.event.id)).toEqual([1_000_000_001, 1_000_000_002, 1_000_000_003, 1_000_000_004]);

    const replay = await server.api('GET', `/api/runs/${runId}/events`);
    const replayUpdates = replay.body.events.filter((e: any) => e.type === 'session_update');
    expect(replayUpdates).toEqual([]);

    ws.close();
  });

  it('replays missed transient log events in order after a WebSocket reconnect', async () => {
    const updates = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'three' } },
    ];
    const first = await connectWs(server);
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ updates, delayMs: 80 }),
    });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    const runId = started.body.id;
    first.send({ type: 'run_log_subscribe', runId, after: 0 });
    await waitFor(async () => first.messages.some((m) => m.type === 'run_log_event' && m.event.runId === runId && m.event.seq === 1));
    first.close();

    await waitFor(async () => (await server.api('GET', `/api/runs/${runId}`)).body.phase === 'terminal');
    const reconnected = await connectWs(server);
    reconnected.send({ type: 'run_log_subscribe', runId, after: 1 });
    await waitFor(async () => reconnected.messages.filter((m) => m.type === 'run_log_event' && m.event.runId === runId).length === 2);
    const replayed = reconnected.messages.filter((m) => m.type === 'run_log_event' && m.event.runId === runId);
    expect(replayed.map((m) => m.event.seq)).toEqual([2, 3]);
    reconnected.close();
  });

  it('broadcasts task state changes so the board updates without polling', async () => {
    const ws = await connectWs(server);
    const created = await server.api('POST', '/api/tasks', { prompt: 'plain prompt' });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);

    await waitFor(async () =>
      ws.messages.some(
        (m) => m.type === 'task_changed' && m.task.id === created.body.id && m.task.state === 'done',
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
    // The Board's Pending columns and HITL treatment read these off the payload.
    expect(msg.task.openBlockerCount).toBe(1);
    expect(msg.task.humanOnly).toBe(false);

    const rest = await server.api('GET', `/api/tasks/${created.body.id}`);
    expect(msg.task).toEqual(rest.body);
    ws.close();
  });

  it('re-broadcasts a dependant when its blocker escalates, so blockedOnFailed shows live', async () => {
    const ws = await connectWs(server);
    const blocker = await server.api('POST', '/api/tasks', { prompt: 'blocker' });
    const dependant = await server.api('POST', '/api/tasks', { prompt: 'dependant', dependsOn: [blocker.body.id] });
    await waitFor(async () => ws.messages.some((m) => m.type === 'task_changed' && m.task.id === dependant.body.id));
    ws.messages.length = 0;

    await server.app.ctx.tasks.escalate(blocker.body.id, 'escalated to human: attempt 3 of 3 failed');

    await waitFor(async () =>
      ws.messages.some((m) => m.type === 'task_changed' && m.task.id === dependant.body.id && m.task.blockedOnFailed),
    );
    const msg = ws.messages.find((m) => m.type === 'task_changed' && m.task.id === dependant.body.id);
    expect(msg.task).toMatchObject({ state: 'ready', openBlockerCount: 1, blockedOnFailed: true, agentWorkable: false });
    ws.close();
  });
});
