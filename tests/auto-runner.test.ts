import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    expect(config.body.autoRunner).toEqual({ enabled: false, maxConcurrentRuns: 1 });

    const updated = await server.api('PATCH', '/api/config', { autoRunner: { enabled: true } });
    expect(updated.status).toBe(200);
    expect(updated.body.autoRunner.enabled).toBe(true);
  });

  it('starts ready tasks in priority-then-FIFO order, one at a time by default', async () => {
    // Created in this order; priorities chosen so creation order alone is wrong.
    const low = await server.api('POST', '/api/tasks', { prompt: slowScenario(80), priority: 'low' });
    const high = await server.api('POST', '/api/tasks', { prompt: slowScenario(80), priority: 'high' });
    const normal1 = await server.api('POST', '/api/tasks', { prompt: slowScenario(80), priority: 'normal' });
    const normal2 = await server.api('POST', '/api/tasks', { prompt: slowScenario(80), priority: 'normal' });

    await server.api('PATCH', '/api/config', { autoRunner: { enabled: true } });

    for (const task of [high, normal1, normal2, low]) {
      await waitFor(async () => (await state(task.body.id)) === 'awaiting-review');
    }

    // Run ids are allocated at start: they encode the actual start order.
    const runIdOf = async (taskId: number) =>
      (await server.api('GET', `/api/tasks/${taskId}/runs`)).body.runs[0].id;
    const order = [
      await runIdOf(high.body.id),
      await runIdOf(normal1.body.id),
      await runIdOf(normal2.body.id),
      await runIdOf(low.body.id),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('never exceeds maxConcurrentRuns and pulls the next task when a slot frees', async () => {
    await server.api('PATCH', '/api/config', { autoRunner: { maxConcurrentRuns: 2 } });
    const t1 = await server.api('POST', '/api/tasks', { prompt: slowScenario(150) });
    const t2 = await server.api('POST', '/api/tasks', { prompt: slowScenario(150) });
    const t3 = await server.api('POST', '/api/tasks', { prompt: slowScenario(150) });

    await server.api('PATCH', '/api/config', { autoRunner: { enabled: true } });

    // Two start immediately, the third waits.
    await waitFor(async () => (await state(t1.body.id)) === 'running' && (await state(t2.body.id)) === 'running');
    expect(await state(t3.body.id)).toBe('ready');

    // A slot frees → the third starts; still never more than two at once.
    await waitFor(async () => (await state(t3.body.id)) === 'running');
    const states = await Promise.all([t1, t2, t3].map((t) => state(t.body.id)));
    expect(states.filter((s) => s === 'running').length).toBeLessThanOrEqual(2);

    for (const t of [t1, t2, t3]) {
      await waitFor(async () => (await state(t.body.id)) === 'awaiting-review');
    }
  });

  it('starts nothing when off, while manual run-now still works', async () => {
    const task = await server.api('POST', '/api/tasks', { prompt: 'manual' });
    await new Promise((r) => setTimeout(r, 300));
    expect(await state(task.body.id)).toBe('ready');

    await server.api('POST', `/api/tasks/${task.body.id}/run`);
    await waitFor(async () => (await state(task.body.id)) === 'awaiting-review');
  });

  it('picks up newly ready tasks (e.g. unblocked dependents) without prodding', async () => {
    await server.api('PATCH', '/api/config', { autoRunner: { enabled: true } });
    const dep = await server.api('POST', '/api/tasks', { prompt: 'dep task' });
    const dependent = await server.api('POST', '/api/tasks', {
      prompt: 'dependent task',
      dependsOn: [dep.body.id],
    });

    await waitFor(async () => (await state(dep.body.id)) === 'awaiting-review');
    expect(await state(dependent.body.id)).toBe('blocked');

    await server.api('POST', `/api/tasks/${dep.body.id}/accept`);
    // blocked → ready → auto-started → awaiting-review, hands-free.
    await waitFor(async () => (await state(dependent.body.id)) === 'awaiting-review');
  });
});
