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

  it('Reject with guidance spawns a new Attempt carrying the recorded guidance (ADR-0038)', async () => {
    const ticket = await startEscalatedTicket({ baseBranch: 'integration/x' });
    const rejected = await server.api('POST', `/api/tasks/${ticket.id}/reject`, {
      guidance: 'Add the CSV header and cover an empty result.',
      start: true,
    });
    expect(rejected.status).toBe(200);

    // ADR-0038: Reject creates a NEW Attempt (number increments) rather than
    // reusing the escalated Attempt row in place. The escalated Attempt keeps
    // its feedback; the corrective run is a fresh Attempt 2 with the guidance
    // folded into its prompt, and it re-escalates as "attempt 1 of 1" (budget
    // reset) once it exhausts its own Attempt budget.
    await waitFor(async () => {
      const attempts = await timeline(ticket.id);
      return attempts.length === 2 && attempts[1]!.state === 'escalated' ? attempts : undefined;
    });
    const attempts = await timeline(ticket.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ number: 1, state: 'escalated', feedback: 'Add the CSV header and cover an empty result.' });
    expect(attempts[1]).toMatchObject({ number: 2, state: 'escalated' });

    const runs = (await server.api('GET', `/api/tasks/${ticket.id}/attempts`)).body.attempts;
    expect(runs).toHaveLength(2);
    expect(runs[1].prompt).toContain('Add the CSV header');
    expect(runs[1].prompt).toContain('crash-before-response');

    const after = await server.api('GET', `/api/tasks/${ticket.id}`);
    expect(after.body.id).toBe(ticket.id);
    expect(after.body.baseBranch).toBe('integration/x');
    // Budget reset: the new Attempt re-escalates as "attempt 1 of 1", not 2-of-N.
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
    // ADR-0038: the corrective run is a new Attempt (number 2), but it stays
    // on the same mirrored Task — no detached duplicate ticket.
    await waitFor(async () => {
      const attempts = await timeline(mirrored.id);
      return attempts.length === 2 && attempts[1]!.state === 'escalated' ? attempts : undefined;
    });

    const after = await server.api('GET', `/api/tasks/${mirrored.id}`);
    expect(after.body).toMatchObject({ id: mirrored.id, origin: 'mirrored', trackerRef: 55502, mapRef: 77, feedback: 'Keep the tracker link.' });
    const runs = (await server.api('GET', `/api/tasks/${mirrored.id}/attempts`)).body.attempts;
    expect(runs).toHaveLength(2);
    const all = (await server.api('GET', '/api/tasks')).body.tasks as { trackerRef: number | null }[];
    expect(all.filter((task) => task.trackerRef === 55502)).toHaveLength(1);
    await waitFor(async () => ((await server.api('GET', `/api/tasks/${mirrored.id}`)).body.state === 'escalated' ? true : undefined));
  });

  it('does not expose the deleted reattempt endpoint', async () => {
    const ticket = await startEscalatedTicket();
    expect((await server.api('POST', `/api/tasks/${ticket.id}/reattempt`, { feedback: 'try again' })).status).toBe(404);
  });
});
