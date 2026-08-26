import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { RunFactStore } from '../src/domain/run-facts.js';

describe('review: accept / reject (direct mode)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  async function runToAwaitingReview(prompt = 'do the thing'): Promise<number> {
    const created = await server.api('POST', '/api/tasks', { prompt });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(
      async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review',
    );
    return created.body.id;
  }

  it('accepting an awaiting-review task completes it (terminal)', async () => {
    const taskId = await runToAwaitingReview();
    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.state).toBe('completed');

    // Terminal: no cancel, no re-accept, no requeue.
    expect((await server.api('POST', `/api/tasks/${taskId}/cancel`)).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${taskId}/accept`)).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${taskId}/requeue`)).status).toBe(409);

    const runs = await server.api('GET', `/api/tasks/${taskId}/runs`);
    expect(runs.body.runs[0].review).toBe('accepted');
  });

  it('a native accept settles under the `operator-accept` disposition (issue #191)', async () => {
    const taskId = await runToAwaitingReview();
    const runsBefore = await server.api('GET', `/api/tasks/${taskId}/runs`);
    const runId = runsBefore.body.runs[0].id;

    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.state).toBe('completed');

    const facts = await new RunFactStore(server.app.ctx.asyncDb).list(runId);
    expect(facts.some((f) => f.type === 'operator-accept')).toBe(true);
    expect(facts.some((f) => f.type === 'agent-finish/unresolved')).toBe(false);
  });

  it('rejecting stores the feedback, fails the run, and starts the corrective attempt', async () => {
    const taskId = await runToAwaitingReview();
    const rejected = await server.api('POST', `/api/tasks/${taskId}/reject`, {
      feedback: 'The tests are red',
    });
    expect(rejected.status).toBe(200);

    const runs = await server.api('GET', `/api/tasks/${taskId}/runs`);
    const run = runs.body.runs[0];
    expect(run.state).toBe('failed');
    expect(run.review).toBe('rejected');
    expect(run.reviewFeedback).toBe('The tests are red');
    // The reject seeded the unified loop: attempt 2 runs on the same ticket.
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'awaiting-review');
    expect((await server.api('GET', `/api/tasks/${taskId}/runs`)).body.runs).toHaveLength(2);
  });

  it("the reject-seeded corrective attempt executes the appended feedback prompt", async () => {
    const taskId = await runToAwaitingReview('original prompt');
    await server.api('POST', `/api/tasks/${taskId}/reject`, { feedback: 'not good enough' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'awaiting-review');

    // The retry ran the appended prompt: the Run records the exact text sent to
    // the harness (ACP session updates are no longer persisted, ADR-0031).
    const second = (await server.api('GET', `/api/tasks/${taskId}/runs`)).body.runs.at(-1);
    expect(second.attempt).toBe(2);
    expect(second.prompt).toContain('original prompt');
    expect(second.prompt).toContain('not good enough');
  });

  it('a rejected task continues its corrective attempt in the SAME Session (issue #147)', async () => {
    // The continuation rule (#311) continues only a warm Session whose reported
    // context usage sits under the threshold: attempt 1 reports 10 of a 100-token
    // window, read back from the settled Run's persisted usage.
    await server.app.ctx.configStore.update({ modelInfo: { 'stub-model': { contextWindow: 100 } } });
    const taskId = await runToAwaitingReview(JSON.stringify({ usage: { inputTokens: 10, outputTokens: 1 } }));
    const run1 = (await server.api('GET', `/api/tasks/${taskId}/runs`)).body.runs[0];
    // The first attempt bound a durable Session on dispatch.
    expect(run1.sessionRowId).not.toBeNull();
    expect(run1.sessionId).not.toBeNull();

    await server.api('POST', `/api/tasks/${taskId}/reject`, { feedback: 'not yet' });
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'awaiting-review');

    const run2 = (await server.api('GET', `/api/tasks/${taskId}/runs`)).body.runs.find(
      (r: { id: number }) => r.id !== run1.id,
    );
    // The retry reloaded run1's Session via session/load rather than opening a
    // cold session/new: the same durable Session row AND the same harness
    // session id (the stub only yields the same session id through session/load —
    // its session/new returns a fresh one). This is the #147 payoff: the fix
    // continues in the same conversation.
    expect(run2.sessionRowId).toBe(run1.sessionRowId);
    expect(run2.sessionId).toBe(run1.sessionId);
  });

  it('accept and reject are only available on awaiting-review tasks', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'p' });
    expect((await server.api('POST', `/api/tasks/${created.body.id}/accept`)).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${created.body.id}/reject`, { feedback: 'x' })).status).toBe(409);
  });
});
