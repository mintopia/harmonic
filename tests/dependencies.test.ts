import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

describe('dependencies', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  const createTask = async (input: object): Promise<any> => {
    const res = await server.api('POST', '/api/tasks', { prompt: 'p', ...input });
    expect(res.status).toBe(201);
    return res.body;
  };

  const getTask = async (id: number) => (await server.api('GET', `/api/tasks/${id}`)).body;

  const runToAwaitingReview = async (id: number) => {
    await server.api('POST', `/api/tasks/${id}/run`);
    await waitFor(async () => (await getTask(id)).state === 'awaiting-review');
  };

  it('derives blocker count and agent-workable from the last open blocker', async () => {
    const dep = await createTask({});
    const dependent = await createTask({ dependsOn: [dep.id] });
    expect(dependent.state).toBe('ready');
    expect(dependent.openBlockerCount).toBe(1);
    expect(dependent.agentWorkable).toBe(false);
    expect(dependent.dependsOn).toEqual([dep.id]);

    // Dependency finishes its run → it remains an open blocker until accepted.
    await runToAwaitingReview(dep.id);
    expect((await getTask(dependent.id)).openBlockerCount).toBe(1);

    // Accept immediately changes the derived fields, without a stored flip.
    await server.api('POST', `/api/tasks/${dep.id}/accept`);
    expect((await getTask(dependent.id)).openBlockerCount).toBe(0);
    expect((await getTask(dependent.id)).agentWorkable).toBe(true);
  });

  it('waits for ALL dependencies before unblocking', async () => {
    const dep1 = await createTask({});
    const dep2 = await createTask({});
    const dependent = await createTask({ dependsOn: [dep1.id, dep2.id] });

    await runToAwaitingReview(dep1.id);
    await server.api('POST', `/api/tasks/${dep1.id}/accept`);
    expect((await getTask(dependent.id)).openBlockerCount).toBe(1);

    await runToAwaitingReview(dep2.id);
    await server.api('POST', `/api/tasks/${dep2.id}/accept`);
    expect((await getTask(dependent.id)).state).toBe('ready');
  });

  it('adds and removes blocker edges over REST without changing task state', async () => {
    const dep = await createTask({});
    const task = await createTask({});
    expect(task.state).toBe('ready');

    const added = await server.api('POST', `/api/tasks/${task.id}/dependencies`, { dependsOnId: dep.id });
    expect(added.status).toBe(200);
    expect(added.body.state).toBe('ready');
    expect(added.body.openBlockerCount).toBe(1);
    expect(added.body.agentWorkable).toBe(false);

    const removed = await server.api('DELETE', `/api/tasks/${task.id}/dependencies/${dep.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.openBlockerCount).toBe(0);
    expect(removed.body.agentWorkable).toBe(true);
  });

  it('flags dependents of a failed dependency instead of cascading failure', async () => {
    const dep = await createTask({ prompt: JSON.stringify({ exit: 'crash-before-response' }) });
    const dependent = await createTask({ dependsOn: [dep.id] });

    await server.api('POST', `/api/tasks/${dep.id}/run`);
    await waitFor(async () => (await getTask(dep.id)).state === 'failed');

    const blocked = await getTask(dependent.id);
    expect(blocked.state).toBe('ready');
    expect(blocked.openBlockerCount).toBe(1);
    expect(blocked.blockedOnFailed).toBe(true);

    // The hiccup is retryable: requeue the dep, run, accept — pipeline resumes.
    await server.api('POST', `/api/tasks/${dep.id}/requeue`, { feedback: JSON.stringify({}) });
    // requeue appended feedback, making the prompt non-JSON; run defaults to echo scenario
    await runToAwaitingReview(dep.id);
    await server.api('POST', `/api/tasks/${dep.id}/accept`);
    const after = await getTask(dependent.id);
    expect(after.openBlockerCount).toBe(0);
    expect(after.blockedOnFailed).toBe(false);
  });

  it('rejects dependency cycles at creation time, including transitive and self cycles', async () => {
    const a = await createTask({});
    const b = await createTask({});
    const c = await createTask({});
    expect((await server.api('POST', `/api/tasks/${b.id}/dependencies`, { dependsOnId: a.id })).status).toBe(200);
    expect((await server.api('POST', `/api/tasks/${c.id}/dependencies`, { dependsOnId: b.id })).status).toBe(200);

    // a → b → c chain exists (c depends on b depends on a); adding a depends-on-c closes the loop.
    expect((await server.api('POST', `/api/tasks/${a.id}/dependencies`, { dependsOnId: c.id })).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${a.id}/dependencies`, { dependsOnId: a.id })).status).toBe(409);
  });

  it('cancels a task and its transitive dependents in one step', async () => {
    const a = await createTask({});
    const b = await createTask({ dependsOn: [a.id] });
    const c = await createTask({ dependsOn: [b.id] });
    const unrelated = await createTask({});

    const res = await server.api('POST', `/api/tasks/${a.id}/cancel`, { withDependents: true });
    expect(res.status).toBe(200);
    expect((await getTask(a.id)).state).toBe('cancelled');
    expect((await getTask(b.id)).state).toBe('cancelled');
    expect((await getTask(c.id)).state).toBe('cancelled');
    expect((await getTask(unrelated.id)).state).toBe('ready');
  });

  it('cancels with an empty application/json body — optional-body POST must not 500', async () => {
    const t = await createTask({});
    // A client that sets a JSON content-type but sends no bytes: the default
    // Fastify parser threw FST_ERR_CTP_EMPTY_JSON_BODY, which the error handler
    // turned into a 500. The tolerant parser treats empty as no body.
    const res = await fetch(`${server.baseUrl}/api/tasks/${t.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `harmonic_session=${server.sessionToken}` },
    });
    expect(res.status).toBe(200);
    expect((await getTask(t.id)).state).toBe('cancelled');
  });

  it('surfaces dependencies in both directions', async () => {
    const dep = await createTask({});
    const dependent = await createTask({ dependsOn: [dep.id] });
    expect((await getTask(dependent.id)).dependsOn).toEqual([dep.id]);
    expect((await getTask(dep.id)).dependents).toEqual([dependent.id]);

    const list = await server.api('GET', '/api/tasks');
    const listed = list.body.tasks.find((t: any) => t.id === dependent.id);
    expect(listed.dependsOn).toEqual([dep.id]);
  });

  it('loads list dependency and run data in batches (issue #258)', async () => {
    const dep = await createTask({});
    await createTask({ dependsOn: [dep.id] });
    const last = await createTask({});

    // `skipReason` mirrors the AutoRunner's per-pass in-memory diagnostics,
    // and no scheduler pass may have covered these just-created tasks yet.
    // Wait until one has (a pass that records `last` necessarily listed every
    // older task too), so the list snapshot and the per-task GETs below read
    // the same steady state instead of racing the pass's map swap.
    await waitFor(async () => (await getTask(last.id)).skipReason !== null);

    const listForTask = vi.spyOn(server.app.ctx.runs, 'listForTask');
    const dependsOn = vi.spyOn(server.app.ctx.tasks, 'dependsOn');
    const dependents = vi.spyOn(server.app.ctx.tasks, 'dependents');
    const reattempts = vi.spyOn(server.app.ctx.tasks, 'reattempts');
    const listToolCalls = vi.spyOn(server.app.ctx.runs, 'listToolCalls');
    const listForTasks = vi.spyOn(server.app.ctx.runs, 'listForTasks');
    const toolCallCounts = vi.spyOn(server.app.ctx.runs, 'toolCallCounts');

    const list = await server.api('GET', '/api/tasks');

    expect(list.status).toBe(200);
    expect(listForTask).not.toHaveBeenCalled();
    expect(dependsOn).not.toHaveBeenCalled();
    expect(dependents).not.toHaveBeenCalled();
    expect(reattempts).not.toHaveBeenCalled();
    expect(listToolCalls).not.toHaveBeenCalled();
    expect(listForTasks).toHaveBeenCalledOnce();
    expect(toolCallCounts).toHaveBeenCalledOnce();

    vi.restoreAllMocks();

    for (const task of list.body.tasks) {
      expect((await server.api('GET', `/api/tasks/${task.id}`)).body).toEqual(task);
    }
  });
});
