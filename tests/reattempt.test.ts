import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type TestServer } from './helpers.js';

describe('linked re-attempts', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('creates a new task linked to the original, copying config and storing trimmed feedback', async () => {
    const original = (
      await server.api('POST', '/api/tasks', {
        prompt: 'Add a CSV export endpoint',
        harness: 'claude',
        model: 'my-custom-model',
        priority: 'high',
        isolationMode: 'worktree',
        state: 'draft',
      })
    ).body;
    // Only a finished task can be re-attempted; cancel to reach a terminal state.
    await server.api('POST', `/api/tasks/${original.id}/cancel`);

    const res = await server.api('POST', `/api/tasks/${original.id}/reattempt`, {
      feedback: '  Add a header row.\n\nHandle empty result sets.  ',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      prompt: 'Add a CSV export endpoint',
      harness: 'claude',
      model: 'my-custom-model',
      priority: 'high',
      isolationMode: 'worktree',
      reattemptOf: original.id,
      state: 'ready',
    });
    // Feedback is stored in full but trimmed of surrounding whitespace.
    expect(res.body.feedback).toBe('Add a header row.\n\nHandle empty result sets.');
    expect(res.body.id).not.toBe(original.id);

    // The original is left untouched apart from its own terminal state.
    const orig = await server.api('GET', `/api/tasks/${original.id}`);
    expect(orig.body.state).toBe('cancelled');
    expect(orig.body.reattemptOf).toBeNull();
    expect(orig.body.feedback).toBeNull();
    // Reverse link: the original knows what it was re-attempted as.
    expect(orig.body.reattempts).toContain(res.body.id);
  });

  it('copies dependencies and is blocked when a dependency is unmet', async () => {
    const dep = (await server.api('POST', '/api/tasks', { prompt: 'the dependency', state: 'draft' })).body;
    const original = (await server.api('POST', '/api/tasks', { prompt: 'needs the dep', dependsOn: [dep.id] })).body;
    expect(original.state).toBe('blocked');
    await server.api('POST', `/api/tasks/${original.id}/cancel`);

    const res = await server.api('POST', `/api/tasks/${original.id}/reattempt`, {});
    expect(res.status).toBe(201);
    expect(res.body.dependsOn).toContain(dep.id);
    expect(res.body.state).toBe('blocked');
    expect(res.body.reattemptOf).toBe(original.id);
    // Feedback is optional — omitted means none.
    expect(res.body.feedback).toBeNull();
  });

  it("rewires the original's dependents onto the re-attempt so the pipeline continues", async () => {
    const a = (await server.api('POST', '/api/tasks', { prompt: 'produces the artifact', state: 'draft' })).body;
    const b = (await server.api('POST', '/api/tasks', { prompt: 'consumes the artifact', dependsOn: [a.id] })).body;
    expect(b.state).toBe('blocked');
    await server.api('POST', `/api/tasks/${a.id}/cancel`);

    const aPrime = (await server.api('POST', `/api/tasks/${a.id}/reattempt`, {})).body;

    // b now waits on the re-attempt, not the cancelled original.
    const bAfter = (await server.api('GET', `/api/tasks/${b.id}`)).body;
    expect(bAfter.dependsOn).toContain(aPrime.id);
    expect(bAfter.dependsOn).not.toContain(a.id);
    const aAfter = (await server.api('GET', `/api/tasks/${a.id}`)).body;
    expect(aAfter.dependents).not.toContain(b.id);
    const aPrimeFull = (await server.api('GET', `/api/tasks/${aPrime.id}`)).body;
    expect(aPrimeFull.dependents).toContain(b.id);
  });

  it('refuses to re-attempt a task that is not finished', async () => {
    const t = (await server.api('POST', '/api/tasks', { prompt: 'still going' })).body; // ready, non-terminal
    const res = await server.api('POST', `/api/tasks/${t.id}/reattempt`, { feedback: 'x' });
    expect(res.status).toBe(409);
  });

  it('404s for a missing task', async () => {
    const res = await server.api('POST', '/api/tasks/999999/reattempt', { feedback: 'x' });
    expect(res.status).toBe(404);
  });
});
