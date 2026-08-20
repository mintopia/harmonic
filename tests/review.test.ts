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

    const facts = new RunFactStore(server.app.ctx.db).list(runId);
    expect(facts.some((f) => f.type === 'operator-accept')).toBe(true);
    expect(facts.some((f) => f.type === 'agent-finish/unresolved')).toBe(false);
  });

  it('rejecting stores the feedback and fails the task', async () => {
    const taskId = await runToAwaitingReview();
    const rejected = await server.api('POST', `/api/tasks/${taskId}/reject`, {
      feedback: 'The tests are red',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.state).toBe('failed');

    const runs = await server.api('GET', `/api/tasks/${taskId}/runs`);
    const run = runs.body.runs[0];
    expect(run.review).toBe('rejected');
    expect(run.reviewFeedback).toBe('The tests are red');
  });

  it('a rejected task re-queued with feedback executes the appended prompt', async () => {
    const taskId = await runToAwaitingReview('original prompt');
    await server.api('POST', `/api/tasks/${taskId}/reject`, { feedback: 'not good enough' });

    const requeued = await server.api('POST', `/api/tasks/${taskId}/requeue`, {
      feedback: 'not good enough',
    });
    expect(requeued.status).toBe(200);
    expect(requeued.body.prompt).toContain('original prompt');
    expect(requeued.body.prompt).toContain('not good enough');

    const second = await server.api('POST', `/api/tasks/${taskId}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'awaiting-review');

    // The stub echoes the prompt it received: the retry ran the appended one.
    const events = await server.api('GET', `/api/runs/${second.body.id}/events`);
    const echo = events.body.events.find((e: any) => e.payload?.content?.text?.startsWith('prompt-received:'));
    expect(echo.payload.content.text).toContain('original prompt');
    expect(echo.payload.content.text).toContain('not good enough');
  });

  it('a rejected task requeued and re-run continues in the SAME Session (issue #147)', async () => {
    const taskId = await runToAwaitingReview('continue me');
    const run1 = (await server.api('GET', `/api/tasks/${taskId}/runs`)).body.runs[0];
    // The first attempt bound a durable Session on dispatch.
    expect(run1.sessionRowId).not.toBeNull();
    expect(run1.sessionId).not.toBeNull();

    await server.api('POST', `/api/tasks/${taskId}/reject`, { feedback: 'not yet' });
    await server.api('POST', `/api/tasks/${taskId}/requeue`, { feedback: 'not yet' });
    const started = await server.api('POST', `/api/tasks/${taskId}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'awaiting-review');

    const run2 = (await server.api('GET', `/api/tasks/${taskId}/runs`)).body.runs.find(
      (r: { id: number }) => r.id === started.body.id,
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
