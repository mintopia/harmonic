import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

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

describe('linked re-attempts continue in the same Session (issue #147)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('a reattempt of a rejected task reloads the ORIGINAL task’s Session', async () => {
    const original = (await server.api('POST', '/api/tasks', { prompt: 'do the thing' })).body;
    await server.api('POST', `/api/tasks/${original.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${original.id}`)).body.state === 'awaiting-review');
    const origRun = (await server.api('GET', `/api/tasks/${original.id}/runs`)).body.runs[0];
    expect(origRun.sessionRowId).not.toBeNull();
    expect(origRun.sessionId).not.toBeNull();

    // Reject → the original reaches a terminal (failed) state so it can be re-attempted.
    await server.api('POST', `/api/tasks/${original.id}/reject`, { feedback: 'try again' });

    const reattempt = (await server.api('POST', `/api/tasks/${original.id}/reattempt`, { feedback: 'try again' })).body;
    const started = await server.api('POST', `/api/tasks/${reattempt.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${reattempt.id}`)).body.state === 'awaiting-review');

    const run2 = (await server.api('GET', `/api/tasks/${reattempt.id}/runs`)).body.runs.find(
      (r: { id: number }) => r.id === started.body.id,
    );
    // The re-attempt is a NEW Task (linked via reattemptOf), yet its Run reloads
    // the original Task's Session (session/load) — the fix continues the same
    // conversation across the re-attempt boundary, not a cold restart.
    expect(run2.sessionRowId).toBe(origRun.sessionRowId);
    expect(run2.sessionId).toBe(origRun.sessionId);
  });

  it('a condensed re-attempt opts out of the bind and starts a FRESH Session (issue #170)', async () => {
    const original = (await server.api('POST', '/api/tasks', { prompt: 'do the thing' })).body;
    await server.api('POST', `/api/tasks/${original.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${original.id}`)).body.state === 'awaiting-review');
    const origRun = (await server.api('GET', `/api/tasks/${original.id}/runs`)).body.runs[0];
    expect(origRun.sessionRowId).not.toBeNull();

    // Preview the continuation offer the reject dialog would show: a live Session
    // is present, so the operator gets the full-vs-condensed choice.
    const preview = (await server.api('GET', `/api/tasks/${original.id}/continuation`)).body;
    expect(preview.available).toBe(true);
    expect(preview.continueFull.estimate.note).toEqual(expect.any(String));
    // The condensed path now carries its own computed cost band (issue #177),
    // served through continuationPreviewSchema on the REST preview endpoint.
    expect(preview.startCondensed.session).toBe('new');
    expect(preview.startCondensed.conversation).toBe('condensed');
    expect(['warm', 'cold', 'unknown']).toContain(preview.startCondensed.estimate.band);
    expect(preview.startCondensed.estimate.note).toEqual(expect.any(String));

    await server.api('POST', `/api/tasks/${original.id}/reject`, { feedback: 'try again' });

    // The operator picks "start condensed" — the re-attempt records the choice.
    const reattempt = (
      await server.api('POST', `/api/tasks/${original.id}/reattempt`, {
        feedback: 'try again',
        continuation: 'condensed',
      })
    ).body;
    const started = await server.api('POST', `/api/tasks/${reattempt.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${reattempt.id}`)).body.state === 'awaiting-review');

    const run2 = (await server.api('GET', `/api/tasks/${reattempt.id}/runs`)).body.runs.find(
      (r: { id: number }) => r.id === started.body.id,
    );
    // Condensed ⇒ a brand-new Session (session/new), NOT the original's — the
    // feedback still rides the prompt, but the full conversation is not replayed.
    expect(run2.sessionRowId).not.toBe(origRun.sessionRowId);
    expect(run2.sessionId).not.toBe(origRun.sessionId);
  });

  it('GET /continuation reports available:false for a task that never bound a Session', async () => {
    const t = (await server.api('POST', '/api/tasks', { prompt: 'no run yet' })).body;
    const preview = (await server.api('GET', `/api/tasks/${t.id}/continuation`)).body;
    expect(preview).toEqual({ available: false });
  });

  // Regression: a Task requeued to `ready` after its last Run was rejected must
  // still be re-attemptable. Live symptom (task 295 / run 364): rejecting a
  // reviewed run whose Task had since gone back to `ready` failed with
  // `invalid_state: ... only a finished task ... can be re-attempted`, because
  // the reject dialog re-attempts as a second call and the terminal-state guard
  // refused the now-`ready` Task.
  it('re-attempts a task requeued to ready whose last run was rejected, and re-fails the original', async () => {
    const original = (await server.api('POST', '/api/tasks', { prompt: 'do the thing' })).body;
    await server.api('POST', `/api/tasks/${original.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${original.id}`)).body.state === 'awaiting-review');

    // Reject → the Task settles `failed` and its Run records review=rejected.
    await server.api('POST', `/api/tasks/${original.id}/reject`, { feedback: 'not quite' });
    expect((await server.api('GET', `/api/tasks/${original.id}`)).body.state).toBe('failed');
    // Something requeues it (e.g. an operator/agent re-queue) → back to `ready`
    // while its last Run is still failed+rejected.
    await server.api('POST', `/api/tasks/${original.id}/requeue`);
    expect((await server.api('GET', `/api/tasks/${original.id}`)).body.state).toBe('ready');

    // The re-attempt now succeeds (previously 409'd on the `ready` Task)…
    const res = await server.api('POST', `/api/tasks/${original.id}/reattempt`, { feedback: 'try again' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ reattemptOf: original.id, state: 'ready' });
    // …and the requeued original is brought back to `failed` so it is not also
    // scheduled alongside the re-attempt (no duplicate work).
    expect((await server.api('GET', `/api/tasks/${original.id}`)).body.state).toBe('failed');
  });

  it('still refuses to re-attempt a fresh ready task that never produced a finished run', async () => {
    const t = (await server.api('POST', '/api/tasks', { prompt: 'never ran' })).body; // ready, no runs
    const res = await server.api('POST', `/api/tasks/${t.id}/reattempt`, { feedback: 'x' });
    expect(res.status).toBe(409);
  });
});
