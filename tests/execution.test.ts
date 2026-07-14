import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

const scenario = (s: object) => JSON.stringify(s);

describe('run execution over ACP (direct mode)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  async function createAndRun(scenarioObj: object): Promise<{ taskId: number; runId: number }> {
    const created = await server.api('POST', '/api/tasks', { prompt: scenario(scenarioObj) });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    return { taskId: created.body.id, runId: started.body.id };
  }

  it('runs a ready task to awaiting-review, persisting every session/update as a run event', async () => {
    const updates = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working…' } },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Write file',
        kind: 'edit',
        status: 'pending',
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
    ];
    const { taskId, runId } = await createAndRun({ updates, stopReason: 'end_turn' });

    // Task passes through running…
    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'awaiting-review' ? body : undefined;
    });
    expect(task.state).toBe('awaiting-review');

    const run = await server.api('GET', `/api/runs/${runId}`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ taskId, attempt: 1, state: 'completed', stopReason: 'end_turn' });
    expect(run.body.finishedAt).toBeGreaterThan(0);

    const events = await server.api('GET', `/api/runs/${runId}/events`);
    expect(events.status).toBe(200);
    const persisted = events.body.events.filter((e: any) => e.type === 'session_update');
    expect(persisted.map((e: any) => e.payload.sessionUpdate)).toEqual([
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
    ]);
    // seq is a stable per-run ordering
    expect(events.body.events.map((e: any) => e.seq)).toEqual(
      [...events.body.events.map((e: any) => e.seq)].sort((a: number, b: number) => a - b),
    );
  });

  it('records each attempt as a distinct run and history survives retries', async () => {
    const { taskId, runId } = await createAndRun({ exit: 'crash-before-response' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'failed');

    const requeued = await server.api('POST', `/api/tasks/${taskId}/requeue`);
    expect(requeued.status).toBe(200);
    expect(requeued.body.state).toBe('ready');

    const second = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(runId);
    expect(second.body.attempt).toBe(2);

    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'failed');
    const runs = await server.api('GET', `/api/tasks/${taskId}/runs`);
    expect(runs.body.runs).toHaveLength(2);
  });

  it('moves the task to failed when the harness crashes mid-run', async () => {
    const { taskId, runId } = await createAndRun({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'about to die' } }],
      exit: 'crash-before-response',
    });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'failed');
    const run = await server.api('GET', `/api/runs/${runId}`);
    expect(run.body.state).toBe('failed');
    expect(run.body.reason).toBeTruthy();
  });

  it('cancelling a running task kills the harness process and the run', async () => {
    const { taskId, runId } = await createAndRun({ exit: 'hang' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'running');

    const cancelled = await server.api('POST', `/api/tasks/${taskId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe('cancelled');

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'cancelled' ? body : undefined;
    });
    expect(run.state).toBe('cancelled');
  });

  it('auto-grants permission requests and records them as run events', async () => {
    const { taskId, runId } = await createAndRun({
      requestPermission: { title: 'Write hello.txt' },
    });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'awaiting-review');

    const events = await server.api('GET', `/api/runs/${runId}/events`);
    const types = events.body.events.map((e: any) => e.type);
    expect(types).toContain('permission_request');
    // The stub echoes the outcome we returned — proving the grant went over the wire.
    const echo = events.body.events.find(
      (e: any) => e.type === 'session_update' && e.payload.content?.text?.startsWith('permission:'),
    );
    expect(echo.payload.content.text).toContain('selected');
  });

  it('run rejects tasks that are not ready', async () => {
    const draft = await server.api('POST', '/api/tasks', { prompt: 'p', state: 'draft' });
    expect((await server.api('POST', `/api/tasks/${draft.body.id}/run`)).status).toBe(409);
  });
});

describe('crash recovery', () => {
  it('marks in-flight runs failed with reason "interrupted" on restart, never re-running them', async () => {
    const server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: scenario({ exit: 'hang' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'running');

    // Simulate a workspace reboot: close the app but keep the data dir.
    await server.app.close();
    const reopened = await startServer(stubHarness(), { dataDir: server.dataDir });

    const task = await reopened.api('GET', `/api/tasks/${created.body.id}`);
    expect(task.body.state).toBe('failed');
    const run = await reopened.api('GET', `/api/runs/${started.body.id}`);
    expect(run.body.state).toBe('failed');
    expect(run.body.reason).toBe('interrupted');

    await reopened.close();
  });
});
