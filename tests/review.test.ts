import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

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

  it('accept and reject are only available on awaiting-review tasks', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'p' });
    expect((await server.api('POST', `/api/tasks/${created.body.id}/accept`)).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${created.body.id}/reject`, { feedback: 'x' })).status).toBe(409);
  });
});
