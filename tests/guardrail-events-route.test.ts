import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startServer, stubHarness, type TestServer } from './helpers.js';

/**
 * `GET /api/attempts/:id/guardrail-events` (issue #171): the REST surface over
 * `GuardrailEventStore.list`, mirroring `GET /runs/:id/events`'s shape and
 * 404 behaviour.
 */
describe('GET /api/attempts/:id/guardrail-events (issue #171)', () => {
  let server: TestServer;
  const ctx = () => server.app.ctx;

  beforeEach(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await server.close();
  });

  it('lists a run\'s guardrail events in seq order, with payload parsed back to an object', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'guardrail target' });
    const task = await ctx().tasks.get(created.body.id);
    const run = await ctx().attempts.create(task.id);
    const attempt = run;

    await ctx().guardrailEvents.append(attempt.id, {
      dimension: 'wall-clock',
      limitValue: 60_000,
      observedValue: 61_000,
      configSource: 'default',
      payload: { note: 'first' },
    });
    await ctx().guardrailEvents.append(attempt.id, {
      dimension: 'progress',
      limitValue: 3,
      observedValue: 4,
      configSource: 'workspace',
      payload: { note: 'second' },
    });

    const res = await server.api('GET', `/api/attempts/${run.id}/guardrail-events`);
    expect(res.status).toBe(200);
    expect(res.body.guardrailEvents).toHaveLength(2);
    expect(res.body.guardrailEvents[0]).toMatchObject({
      attemptId: attempt.id,
      seq: 1,
      dimension: 'wall-clock',
      limitValue: 60_000,
      observedValue: 61_000,
      configSource: 'default',
      payload: { note: 'first' },
    });
    expect(res.body.guardrailEvents[1]).toMatchObject({
      seq: 2,
      dimension: 'progress',
      payload: { note: 'second' },
    });
  });

  it('404s for an unknown run', async () => {
    const res = await server.api('GET', '/api/attempts/999999/guardrail-events');
    expect(res.status).toBe(404);
  });
});
