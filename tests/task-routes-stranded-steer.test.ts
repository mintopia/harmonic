import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppConfig, type DeepPartial } from '../src/config.js';
import { startServer, stubHarness, type TestServer, waitFor } from './helpers.js';

describe('steering/resuming a Task whose Session is incompatible or stranded (issue: 409 after pause+resume across an upgrade)', () => {
  const scenario = (s: object) => JSON.stringify(s);

  let server: TestServer;

  beforeAll(async () => {
    const scenarioPrompt = scenario({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'thinking' } }],
      stopReason: 'end_turn',
    });
    const overrides = stubHarness() as DeepPartial<AppConfig>;
    overrides.harnesses!.claude!.cacheWarmSeconds = 1;
    overrides.maxAttempts = 1;
    overrides.drive = { prompt: scenarioPrompt };
    server = await startServer(overrides);
  });
  afterAll(async () => {
    await server.close();
  });

  /** Runs a mirrored task to escalated with a real, persisted Session. */
  async function escalateWithSession(trackerRef: number) {
    const seed = (await server.api('POST', '/api/tasks', { prompt: 'workspace seed' })).body;
    const workspaceId = (await server.app.ctx.tasks.get(seed.id)).workspaceId ?? undefined;
    const mirrored = await server.app.ctx.tasks.upsertMirrored(
      { trackerRef, prompt: `ticket ${trackerRef}\n\nbody`, workflow: 'implement', wayfinderType: null, mapRef: null, closed: false },
      workspaceId,
    );
    await server.api('POST', `/api/tasks/${mirrored.id}/run`);
    await waitFor(async () => {
      const task = (await server.api('GET', `/api/tasks/${mirrored.id}`)).body;
      return task.state === 'escalated' ? task : undefined;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    return mirrored;
  }

  /** Mutates the persisted Session for `taskId`'s latest Attempt so it is
   * incompatible for continue-full (a stand-in for an adapter bump across
   * an upgrade), returning the Attempt it lives on. */
  async function breakSessionCompatibility(taskId: number) {
    const attempts = await server.app.ctx.attempts.listForTask(taskId);
    const attempt = attempts.at(-1)!;
    const sessionRowId = attempt.sessionRowId!;
    const session = await server.app.ctx.sessions.get(sessionRowId);
    await server.app.ctx.sessions.recordDispatch({
      harness: session.harness,
      harnessSessionId: session.harnessSessionId,
      model: session.model,
      cwd: session.cwd,
      workspaceId: session.workspaceId,
      mcpTemplates: JSON.parse(session.mcpTemplates),
      capabilities: undefined,
      adapterVersion: 'claude@incompatible-999',
      now: Date.now(),
    });
    return attempt;
  }

  it('steers a paused task past an incompatible Session via start-condensed, seeding condensed context and the operator message', async () => {
    const mirrored = await escalateWithSession(93001);
    await server.app.ctx.tasks.setState(mirrored.id, 'ready');
    await server.app.ctx.tasks.setState(mirrored.id, 'working');
    await server.app.ctx.tasks.setState(mirrored.id, 'paused');
    const attemptBefore = await breakSessionCompatibility(mirrored.id);
    const runsBefore = await server.app.ctx.attempts.listForTask(mirrored.id);

    const steered = await server.api('POST', `/api/tasks/${mirrored.id}/steer`, { text: 'pick up despite the upgrade' });
    expect(steered.status).toBe(200);
    expect(steered.body).toEqual({ ok: true });

    const latest = await waitFor(async () => {
      const all = await server.app.ctx.attempts.listForTask(mirrored.id);
      const last = all.at(-1);
      return all.length === runsBefore.length && last?.prompt?.includes('pick up despite the upgrade') ? last : undefined;
    });
    // Same Attempt continued — the counter only advances on a failed verdict.
    expect(latest.id).toBe(attemptBefore.id);
    expect(latest.prompt).toContain('## Prior session (condensed)');
    expect(latest.prompt).toContain('## Operator message');
    expect(latest.prompt).toContain('pick up despite the upgrade');

    const task = (await server.api('GET', `/api/tasks/${mirrored.id}`)).body;
    expect(['working', 'escalated', 'done']).toContain(task.state);
  });

  it('resumePaused starts a live run when the retained Session is incompatible — never a stranded working task', async () => {
    const mirrored = await escalateWithSession(93002);
    await server.app.ctx.tasks.setState(mirrored.id, 'ready');
    await server.app.ctx.tasks.setState(mirrored.id, 'working');
    await server.app.ctx.tasks.setState(mirrored.id, 'paused');
    const attemptBefore = await breakSessionCompatibility(mirrored.id);

    const resumed = await server.app.ctx.runner.resumePaused(mirrored.id);
    expect(resumed.state).toBe('working');

    const running = await waitFor(async () => {
      const attempt = await server.app.ctx.attempts.get(attemptBefore.id);
      return attempt.state === 'running' && attempt.sessionRowId === null ? attempt : undefined;
    });
    expect(running.id).toBe(attemptBefore.id);

    await waitFor(async () => ((await server.api('GET', `/api/tasks/${mirrored.id}`)).body.state !== 'working' ? true : undefined));
  });

  it('steers a working task stranded with no live ActiveRun by relaunching its running Attempt', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'x' });
    const taskId = created.body.id;
    await server.app.ctx.tasks.setState(taskId, 'ready');
    await server.app.ctx.tasks.setState(taskId, 'working');
    const attempt = await server.app.ctx.attempts.create(taskId);
    expect(attempt.state).toBe('running');

    const steered = await server.api('POST', `/api/tasks/${taskId}/steer`, { text: 'relaunch me' });
    expect(steered.status).toBe(200);
    expect(steered.body).toEqual({ ok: true });

    const latest = await waitFor(async () => {
      const all = await server.app.ctx.attempts.listForTask(taskId);
      const last = all.at(-1);
      return all.length === 1 && last?.prompt?.includes('relaunch me') ? last : undefined;
    });
    expect(latest.id).toBe(attempt.id);

    await waitFor(async () => ((await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done' ? true : undefined));
  });

  it('steers an escalated task past an incompatible Session via start-condensed', async () => {
    const mirrored = await escalateWithSession(93003);
    const attemptBefore = await breakSessionCompatibility(mirrored.id);
    const runsBefore = await server.app.ctx.attempts.listForTask(mirrored.id);

    const steered = await server.api('POST', `/api/tasks/${mirrored.id}/steer`, { text: 'condensed continue' });
    expect(steered.status).toBe(200);
    expect(steered.body).toEqual({ ok: true });

    const latest = await waitFor(async () => {
      const all = await server.app.ctx.attempts.listForTask(mirrored.id);
      const last = all.at(-1);
      return all.length === runsBefore.length && last?.prompt?.includes('condensed continue') ? last : undefined;
    });
    expect(latest.id).toBe(attemptBefore.id);
    expect(latest.prompt).toContain('## Operator message');
  });

  it('POST /tasks/:id/resume reattaches the running Attempt row instead of orphaning it under a new one', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'x' });
    const taskId = created.body.id;
    await server.app.ctx.tasks.setState(taskId, 'ready');
    await server.app.ctx.tasks.setState(taskId, 'working');
    const attempt = await server.app.ctx.attempts.create(taskId);
    await server.app.ctx.tasks.setState(taskId, 'paused');

    const resumed = await server.api('POST', `/api/tasks/${taskId}/resume`, {});
    expect(resumed.status).toBe(200);

    const running = await waitFor(async () => {
      const attempts = await server.app.ctx.attempts.listForTask(taskId);
      const row = attempts.find((a) => a.id === attempt.id);
      return attempts.length === 1 && row?.state === 'running' ? row : undefined;
    });
    expect(running.id).toBe(attempt.id);

    await waitFor(async () => ((await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done' ? true : undefined));
  });

  it('POST /tasks/:id/resume falls back to start-condensed for a paused Task with an incompatible retained Session', async () => {
    const mirrored = await escalateWithSession(93004);
    await server.app.ctx.tasks.setState(mirrored.id, 'ready');
    await server.app.ctx.tasks.setState(mirrored.id, 'working');
    await server.app.ctx.tasks.setState(mirrored.id, 'paused');
    const attemptBefore = await breakSessionCompatibility(mirrored.id);

    const resumed = await server.api('POST', `/api/tasks/${mirrored.id}/resume`, {});
    expect(resumed.status).toBe(200);

    const running = await waitFor(async () => {
      const attempt = await server.app.ctx.attempts.get(attemptBefore.id);
      return attempt.state === 'running' && attempt.sessionRowId === null ? attempt : undefined;
    });
    expect(running.id).toBe(attemptBefore.id);
  });

  it('409s a steer on a done task, and on a cancelled task', async () => {
    const done = await server.api('POST', '/api/tasks', { prompt: 'quick native task' });
    await server.api('POST', `/api/tasks/${done.body.id}/run`);
    await waitFor(async () => ((await server.api('GET', `/api/tasks/${done.body.id}`)).body.state === 'done' ? true : undefined));
    const res1 = await server.api('POST', `/api/tasks/${done.body.id}/steer`, { text: 'too late' });
    expect(res1.status).toBe(409);

    const draft = await server.api('POST', '/api/tasks', { prompt: 'never run' });
    await server.api('POST', `/api/tasks/${draft.body.id}/cancel`);
    const res2 = await server.api('POST', `/api/tasks/${draft.body.id}/steer`, { text: 'nope' });
    expect(res2.status).toBe(409);
  });
});
