import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

/**
 * Issue #310 replaces linked re-attempt Tasks with corrective Attempts on the
 * original ticket. These cover the old reattempt entry points at their real
 * replacement: review rejection and the removed route.
 */
describe('unified corrective attempts', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({ ...stubHarness(), maxAttempts: 2 });
  });
  afterAll(async () => {
    await server.close();
  });

  async function startReviewableTicket(input: Record<string, unknown> = {}) {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ stopReason: 'end_turn' }),
      ...input,
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    await waitFor(async () => {
      const task = (await server.api('GET', `/api/tasks/${created.body.id}`)).body;
      return task.state === 'awaiting-review' ? task : undefined;
    });
    return created.body as { id: number; baseBranch: string | null };
  }

  const timeline = async (taskId: number) => {
    const response = await server.api('GET', `/api/tasks/${taskId}/attempts`);
    expect(response.status).toBe(200);
    return response.body.attempts as { number: number; state: string; feedback: string | null; tasks: { type: string }[] }[];
  };

  it('review rejection starts attempt 2 on the same native ticket with the recorded feedback', async () => {
    const ticket = await startReviewableTicket({ baseBranch: 'integration/x' });
    const rejected = await server.api('POST', `/api/tasks/${ticket.id}/reject`, {
      feedback: 'Add the CSV header and cover an empty result.',
    });
    expect(rejected.status).toBe(200);

    await waitFor(async () => {
      const attempts = await timeline(ticket.id);
      return attempts.length === 2 ? attempts : undefined;
    });
    const attempts = await timeline(ticket.id);
    expect(attempts.map((attempt) => ({ number: attempt.number, state: attempt.state }))).toEqual([
      { number: 1, state: 'failed' },
      { number: 2, state: 'running' },
    ]);
    expect(attempts[0]!.feedback).toContain('Add the CSV header');
    expect(attempts[1]!.tasks.map((task) => task.type)).toContain('implementation');

    const after = await server.api('GET', `/api/tasks/${ticket.id}`);
    expect(after.body.id).toBe(ticket.id);
    expect(after.body.baseBranch).toBe('integration/x');
    await server.api('POST', `/api/tasks/${ticket.id}/cancel`);
  });

  it('mirrored rejection enters the identical corrective Attempt loop without a detached task', async () => {
    const seed = (await server.api('POST', '/api/tasks', { prompt: 'workspace seed' })).body;
    const workspaceId = (await server.app.ctx.tasks.get(seed.id)).workspaceId ?? undefined;
    const mirrored = await server.app.ctx.tasks.upsertMirrored(
      {
        trackerRef: 55502,
        prompt: JSON.stringify({ stopReason: 'end_turn' }),
        workflow: 'implement',
        wayfinderType: null,
        drive: 'hitl',
        mapRef: 77,
        closed: false,
      },
      workspaceId,
    );
    await server.api('POST', `/api/tasks/${mirrored.id}/run`);
    await waitFor(async () => {
      const task = (await server.api('GET', `/api/tasks/${mirrored.id}`)).body;
      return task.state === 'awaiting-review' ? task : undefined;
    });

    const rejected = await server.api('POST', `/api/tasks/${mirrored.id}/reject`, { feedback: 'Keep the tracker link.' });
    expect(rejected.status).toBe(200);
    await waitFor(async () => {
      const attempts = await timeline(mirrored.id);
      return attempts.length === 2 ? attempts : undefined;
    });

    const after = await server.api('GET', `/api/tasks/${mirrored.id}`);
    expect(after.body).toMatchObject({ id: mirrored.id, origin: 'mirrored', trackerRef: 55502, mapRef: 77 });
    expect((await timeline(mirrored.id))[0]!.feedback).toContain('Keep the tracker link.');
    const all = (await server.api('GET', '/api/tasks')).body.tasks as { trackerRef: number | null }[];
    expect(all.filter((task) => task.trackerRef === 55502)).toHaveLength(1);
    await server.api('POST', `/api/tasks/${mirrored.id}/cancel`);
  });

  it('does not expose the deleted reattempt endpoint', async () => {
    const ticket = await startReviewableTicket();
    const response = await server.api('POST', `/api/tasks/${ticket.id}/reattempt`, { feedback: 'try again' });
    expect(response.status).toBe(404);
  });
});
