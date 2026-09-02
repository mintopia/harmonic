import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

const slowScenario = (ms: number) =>
  JSON.stringify({
    updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'tick' } }],
    delayMs: ms,
  });

describe('auto-runner', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await server.close();
  });

  const getTask = async (id: number) => (await server.api('GET', `/api/tasks/${id}`)).body;
  const state = async (id: number) => (await getTask(id)).state;

  it('exposes the toggle over REST, default off', async () => {
    const config = await server.api('GET', '/api/config');
    expect(config.body.autoRunner).toEqual({ enabled: false, maxConcurrentAttempts: 1 });

    const updated = await server.api('PATCH', '/api/config', { autoRunner: { enabled: true } });
    expect(updated.status).toBe(200);
    expect(updated.body.autoRunner.enabled).toBe(true);
  });

  it('starts ready tasks in priority-then-FIFO order, one at a time by default', async () => {
    const dir = () => mkdtempSync(join(tmpdir(), 'harmonic-ar-ord-'));
    const low = await server.api('POST', '/api/tasks', { prompt: slowScenario(80), priority: 'low', workingDir: dir() });
    const high = await server.api('POST', '/api/tasks', { prompt: slowScenario(80), priority: 'high', workingDir: dir() });
    const normal1 = await server.api('POST', '/api/tasks', { prompt: slowScenario(80), priority: 'normal', workingDir: dir() });
    const normal2 = await server.api('POST', '/api/tasks', { prompt: slowScenario(80), priority: 'normal', workingDir: dir() });

    await server.api('PATCH', '/api/config', { autoRunner: { enabled: true } });

    for (const task of [high, normal1, normal2, low]) {
      await waitFor(async () => (await state(task.body.id)) === 'done');
    }

    const runIdOf = async (taskId: number) =>
      (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts[0].id;
    const order = [
      await runIdOf(high.body.id),
      await runIdOf(normal1.body.id),
      await runIdOf(normal2.body.id),
      await runIdOf(low.body.id),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('never exceeds maxConcurrentAttempts and pulls the next task when a slot frees', async () => {
    await server.api('PATCH', '/api/config', { autoRunner: { maxConcurrentAttempts: 2 } });
    const t1 = await server.api('POST', '/api/tasks', {
      prompt: slowScenario(150),
      workingDir: mkdtempSync(join(tmpdir(), 'harmonic-ar-')),
    });
    const t2 = await server.api('POST', '/api/tasks', {
      prompt: slowScenario(150),
      workingDir: mkdtempSync(join(tmpdir(), 'harmonic-ar-')),
    });
    const t3 = await server.api('POST', '/api/tasks', {
      prompt: slowScenario(150),
      workingDir: mkdtempSync(join(tmpdir(), 'harmonic-ar-')),
    });

    await server.api('PATCH', '/api/config', { autoRunner: { enabled: true } });

    await waitFor(async () => (await state(t1.body.id)) === 'working' && (await state(t2.body.id)) === 'working');
    expect(await state(t3.body.id)).toBe('ready');

    await waitFor(async () => (await state(t3.body.id)) === 'working');
    const states = await Promise.all([t1, t2, t3].map((t) => state(t.body.id)));
    expect(states.filter((s) => s === 'working').length).toBeLessThanOrEqual(2);

    for (const t of [t1, t2, t3]) {
      await waitFor(async () => (await state(t.body.id)) === 'done');
    }
  });

  it('refills from a finished-run event even while the interval is stopped', async () => {
    await server.api('PATCH', '/api/config', { autoRunner: { enabled: true } });
    server.app.ctx.autoRunner.stop();
    const finishedTask = await server.api('POST', '/api/tasks', { prompt: 'finished', workingDir: mkdtempSync(join(tmpdir(), 'harmonic-ar-event-')) });
    await server.api('POST', `/api/tasks/${finishedTask.body.id}/run`);
    await waitFor(async () => (await state(finishedTask.body.id)) === 'done');
    const task = await server.api('POST', '/api/tasks', { prompt: slowScenario(80), workingDir: mkdtempSync(join(tmpdir(), 'harmonic-ar-event-')) });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await state(task.body.id)).toBe('ready');

    server.app.ctx.bus.emit('attempt_changed', (await server.app.ctx.attempts.listForTask(finishedTask.body.id))[0]!);
    await waitFor(async () => (await state(task.body.id)) === 'done');
  });

  it('starts nothing when off, while manual run-now still works', async () => {
    const task = await server.api('POST', '/api/tasks', { prompt: 'manual' });
    await new Promise((r) => setTimeout(r, 100));
    expect(await state(task.body.id)).toBe('ready');

    await server.api('POST', `/api/tasks/${task.body.id}/run`);
    await waitFor(async () => (await state(task.body.id)) === 'done');
  });

  it('holds the Work Context House Rule: a second Task waits on a busy direct context while it is working, then starts once it merges (issue #120)', async () => {
    await server.api('PATCH', '/api/config', { autoRunner: { maxConcurrentAttempts: 2 } });
    const first = await server.api('POST', '/api/tasks', { prompt: slowScenario(120) });
    const second = await server.api('POST', '/api/tasks', { prompt: slowScenario(120) });

    await server.api('PATCH', '/api/config', { autoRunner: { enabled: true } });

    await waitFor(async () => (await state(first.body.id)) === 'working');
    await waitFor(
      async () =>
        server.app.ctx.autoRunner.skipReasonFor(second.body.id) ===
        `Work Context held by task ${first.body.id} (working)`,
    );
    expect(await state(second.body.id)).toBe('ready');

    await waitFor(async () => (await state(first.body.id)) === 'done');
    await waitFor(async () => (await state(second.body.id)) === 'done');
  });

  it('picks up newly ready tasks (e.g. unblocked dependents) without prodding', async () => {
    await server.api('PATCH', '/api/config', { autoRunner: { enabled: true } });
    const dep = await server.api('POST', '/api/tasks', { prompt: 'dep task' });
    const dependent = await server.api('POST', '/api/tasks', {
      prompt: 'dependent task',
      dependsOn: [dep.body.id],
    });

    await waitFor(async () => (await state(dep.body.id)) === 'working');
    expect(await state(dependent.body.id)).toBe('ready');
    await waitFor(async () => (await state(dep.body.id)) === 'done');
    await waitFor(async () => (await state(dependent.body.id)) === 'done');
  });
});

describe('auto-runner — two-level cap + master gate (issue #60)', () => {
  let server: TestServer;
  let secondDir: string;

  beforeEach(async () => {
    server = await startServer(stubHarness());
    secondDir = mkdtempSync(join(tmpdir(), 'harmonic-ws2-'));
  });
  afterEach(async () => {
    await server.close();
  });

  const state = async (id: number) => (await server.api('GET', `/api/tasks/${id}`)).body.state;
  const defaultWorkspaceId = async () => (await server.api('GET', '/api/workspaces')).body.workspaces[0].id;
  const createWorkspace = async (name: string) =>
    (await server.api('POST', '/api/workspaces', { name, workingDir: secondDir })).body.id;
  const makeTask = (workspaceId: number, ms: number) =>
    server.api('POST', '/api/tasks', {
      prompt: slowScenario(ms),
      workspaceId,
      workingDir: mkdtempSync(join(tmpdir(), 'harmonic-ar2-')),
    });

  const samplePeaksUntil = async (done: () => Promise<boolean>) => {
    let maxTotal = 0;
    const maxByWorkspace = new Map<number, number>();
    do {
      const running: Array<{ workspaceId: number }> = (
        await server.api('GET', '/api/tasks?state=working')
      ).body.tasks;
      maxTotal = Math.max(maxTotal, running.length);
      const now = new Map<number, number>();
      for (const t of running) now.set(t.workspaceId, (now.get(t.workspaceId) ?? 0) + 1);
      for (const [ws, n] of now) maxByWorkspace.set(ws, Math.max(maxByWorkspace.get(ws) ?? 0, n));
      await new Promise((r) => setTimeout(r, 5));
    } while (!(await done()));
    return { maxTotal, maxByWorkspace };
  };

  const allSettled = (ids: number[]) => async () => {
    const states = await Promise.all(ids.map(state));
    return states.every((s) => s === 'done');
  };

  it('never breaches the Machine Ceiling even when per-workspace caps sum higher (3+3, ceiling 4 → ≤4)', async () => {
    const ws1 = await defaultWorkspaceId();
    const ws2 = await createWorkspace('Second');
    await server.api('PATCH', '/api/config', { autoRunner: { maxConcurrentAttempts: 4 } });
    await server.api('PATCH', `/api/workspaces/${ws1}`, { maxConcurrentAttempts: 3 });
    await server.api('PATCH', `/api/workspaces/${ws2}`, { maxConcurrentAttempts: 3 });

    const created = [];
    for (let i = 0; i < 4; i++) created.push(await makeTask(ws1, 120), await makeTask(ws2, 120));
    const ids = created.map((t) => t.body.id);

    await server.api('PATCH', '/api/config', { autoRunner: { enabled: true } });
    const { maxTotal, maxByWorkspace } = await samplePeaksUntil(allSettled(ids));

    expect(maxTotal).toBeLessThanOrEqual(4);
    expect(maxTotal).toBe(4);
    for (const [, n] of maxByWorkspace) expect(n).toBeLessThanOrEqual(3);
  });

  it('holds a per-workspace cap below the ceiling (cap 2, ceiling 10 → ≤2 in that workspace)', async () => {
    const ws1 = await defaultWorkspaceId();
    await server.api('PATCH', '/api/config', { autoRunner: { maxConcurrentAttempts: 10 } });
    await server.api('PATCH', `/api/workspaces/${ws1}`, { maxConcurrentAttempts: 2 });

    const created = [];
    for (let i = 0; i < 4; i++) created.push(await makeTask(ws1, 120));
    const ids = created.map((t) => t.body.id);

    await server.api('PATCH', '/api/config', { autoRunner: { enabled: true } });
    const { maxTotal } = await samplePeaksUntil(allSettled(ids));
    expect(maxTotal).toBeLessThanOrEqual(2);
    expect(maxTotal).toBe(2);
  });

  it('runs only master ∧ workspace-enabled: skips a disabled workspace while the master is on', async () => {
    const ws1 = await defaultWorkspaceId();
    const ws2 = await createWorkspace('Disabled');
    await server.api('PATCH', `/api/workspaces/${ws2}`, { autoRunnerEnabled: false });

    const enabled = await makeTask(ws1, 80);
    const disabled = await makeTask(ws2, 80);

    await server.api('PATCH', '/api/config', { autoRunner: { enabled: true } });

    await waitFor(async () => (await state(enabled.body.id)) === 'done');
    expect(await state(disabled.body.id)).toBe('ready');
  });

  it('master off pauses the fleet even for an explicitly-enabled workspace', async () => {
    const ws1 = await defaultWorkspaceId();
    await server.api('PATCH', `/api/workspaces/${ws1}`, { autoRunnerEnabled: true });

    const task = await makeTask(ws1, 80);
    await new Promise((r) => setTimeout(r, 100));
    expect(await state(task.body.id)).toBe('ready');

    await server.api('PATCH', '/api/config', { autoRunner: { enabled: true } });
    await waitFor(async () => (await state(task.body.id)) === 'done');
  });
});
