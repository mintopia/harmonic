import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

describe('retrying an escalated Ticket after changing its route', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({ ...stubHarness() });
  });
  afterAll(async () => {
    await server.close();
  });

  it('PATCH harness then retry resumes on the new Harness; the never-spawned placeholder does not eat the attempt budget', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'do the thing', harness: 'codex' });
    const taskId = created.body.id as number;
    delete (server.app.ctx.settingsStore.getGlobal().harnesses as Record<string, unknown>).codex;

    await server.api('POST', `/api/tasks/${taskId}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'escalated');
    const escalated = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(escalated.escalationReason).toBe("escalated to human: Harness 'codex' is not configured.");
    expect(escalated.escalationCause).toEqual({ kind: 'harness_unconfigured', harness: 'codex', label: null });

    const placeholder = (await server.api('GET', `/api/tasks/${taskId}/attempts/timeline`)).body;
    expect(placeholder.attempts).toHaveLength(1);
    expect(placeholder.attempts[0]).toMatchObject({ number: 1, state: 'escalated' });
    expect(placeholder.budgetBase).toBe(1);

    expect((await server.api('PATCH', `/api/tasks/${taskId}`, { harness: 'claude' })).status).toBe(200);
    expect((await server.api('POST', `/api/tasks/${taskId}/retry`, { guidance: 'Retry after changing the route.', startNow: true })).status).toBe(200);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done');

    const after = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(after).toMatchObject({ harness: 'claude', escalationReason: null, escalationCause: null });
    const timeline = (await server.api('GET', `/api/tasks/${taskId}/attempts/timeline`)).body;
    const next = timeline.attempts.at(-1);
    expect(next.number - timeline.budgetBase).toBe(1);
    expect(next.state).toBe('passed');
  });
});
