import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

describe('unified corrective attempts', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({ ...stubHarness(), maxAttempts: 1 });
  });
  afterAll(async () => {
    await server.close();
  });

  const crashing = JSON.stringify({ exit: 'crash-before-response' });

  async function startEscalatedTicket(input: Record<string, unknown> = {}) {
    const created = await server.api('POST', '/api/tasks', { prompt: crashing, ...input });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    await waitFor(async () => {
      const task = (await server.api('GET', `/api/tasks/${created.body.id}`)).body;
      return task.state === 'escalated' ? task : undefined;
    });
    return created.body as { id: number; baseBranch: string | null };
  }

  const timeline = async (taskId: number) => {
    const response = await server.api('GET', `/api/tasks/${taskId}/attempts/timeline`);
    expect(response.status).toBe(200);
    return response.body.attempts as { number: number; state: string; feedback: string | null; steps: { type: string }[] }[];
  };

  it('Reject with guidance resumes the escalated Attempt in place with the recorded guidance', async () => {
    const ticket = await startEscalatedTicket({ baseBranch: 'integration/x' });
    const rejected = await server.api('POST', `/api/tasks/${ticket.id}/reject`, {
      guidance: 'Add the CSV header and cover an empty result.',
      start: true,
    });
    expect(rejected.status).toBe(200);

    // Unified manual resume (issue #506): the corrective run reuses the escalated
    // Attempt in place — no second Attempt row — replaying implementation with the
    // guidance folded into its prompt.
    await waitFor(async () => {
      const attempts = await timeline(ticket.id);
      return attempts.length === 1 &&
        attempts[0]!.state === 'escalated' &&
        attempts[0]!.steps.filter((step) => step.type === 'implementation').length >= 2
        ? attempts
        : undefined;
    });
    const attempts = await timeline(ticket.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ number: 1, state: 'escalated' });

    const runs = (await server.api('GET', `/api/tasks/${ticket.id}/attempts`)).body.attempts;
    expect(runs).toHaveLength(1);
    expect(runs[0].prompt).toContain('Add the CSV header');
    expect(runs[0].prompt).toContain('crash-before-response');

    const after = await server.api('GET', `/api/tasks/${ticket.id}`);
    expect(after.body.id).toBe(ticket.id);
    expect(after.body.baseBranch).toBe('integration/x');
    // Budget reset: the resumed Attempt re-escalates as "attempt 1 of 1", not 2-of-N.
    expect(after.body.escalationReason).toMatch(/attempt 1 of 1 failed/);
  });

  it('a mirrored rejection enters the identical corrective Attempt loop without a detached task', async () => {
    const seed = (await server.api('POST', '/api/tasks', { prompt: 'workspace seed' })).body;
    const workspaceId = (await server.app.ctx.tasks.get(seed.id)).workspaceId ?? undefined;
    const mirrored = await server.app.ctx.tasks.upsertMirrored(
      {
        trackerRef: 55502,
        prompt: crashing,
        workflow: 'implement',
        wayfinderType: null,
        mapRef: 77,
        closed: false,
      },
      workspaceId,
    );
    await server.api('POST', `/api/tasks/${mirrored.id}/run`);
    await waitFor(async () => {
      const task = (await server.api('GET', `/api/tasks/${mirrored.id}`)).body;
      return task.state === 'escalated' ? task : undefined;
    });

    const rejected = await server.api('POST', `/api/tasks/${mirrored.id}/reject`, { guidance: 'Keep the tracker link.', start: true });
    expect(rejected.status).toBe(200);
    // Resume-in-place (issue #506): the corrective run reuses the one Attempt; it
    // never spawns a detached duplicate of the mirrored ticket.
    await waitFor(async () => {
      const attempts = await timeline(mirrored.id);
      return attempts.length === 1 &&
        attempts[0]!.state === 'escalated' &&
        attempts[0]!.steps.filter((step) => step.type === 'implementation').length >= 2
        ? attempts
        : undefined;
    });

    const after = await server.api('GET', `/api/tasks/${mirrored.id}`);
    expect(after.body).toMatchObject({ id: mirrored.id, origin: 'mirrored', trackerRef: 55502, mapRef: 77, feedback: 'Keep the tracker link.' });
    const runs = (await server.api('GET', `/api/tasks/${mirrored.id}/attempts`)).body.attempts;
    expect(runs).toHaveLength(1);
    const all = (await server.api('GET', '/api/tasks')).body.tasks as { trackerRef: number | null }[];
    expect(all.filter((task) => task.trackerRef === 55502)).toHaveLength(1);
    await waitFor(async () => ((await server.api('GET', `/api/tasks/${mirrored.id}`)).body.state === 'escalated' ? true : undefined));
  });

  it('does not expose the deleted reattempt or requeue endpoints', async () => {
    const ticket = await startEscalatedTicket();
    expect((await server.api('POST', `/api/tasks/${ticket.id}/reattempt`, { feedback: 'try again' })).status).toBe(404);
    expect((await server.api('POST', `/api/tasks/${ticket.id}/requeue`, { feedback: 'try again' })).status).toBe(404);
  });
});
