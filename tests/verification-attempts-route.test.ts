import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startServer, stubHarness, type TestServer } from './helpers.js';

/**
 * `GET /api/runs/:id/verification-attempts` (issue #169, part of #109): the
 * REST surface over `VerificationAttemptStore.list`, mirroring
 * `GET /runs/:id/guardrail-events`'s shape and 404 behaviour.
 */
describe('GET /api/runs/:id/verification-attempts (issue #169)', () => {
  let server: TestServer;
  const ctx = () => server.app.ctx;

  beforeEach(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await server.close();
  });

  it("lists a run's verification attempts in seq order", async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'verification target' });
    const task = await ctx().tasks.get(created.body.id);
    const run = await ctx().runs.create(task.id);

    ctx().verificationAttempts.append(run.id, {
      mechanism: 'command',
      inputOid: 'oid1',
      verdict: 'pass',
      summary: 'ok',
      output: '',
      mutated: false,
    });
    ctx().verificationAttempts.append(run.id, {
      mechanism: 'critic',
      inputOid: 'oid2',
      verdict: 'fail',
      summary: 'nope',
      output: 'details',
      mutated: true,
    });

    const res = await server.api('GET', `/api/runs/${run.id}/verification-attempts`);
    expect(res.status).toBe(200);
    expect(res.body.verificationAttempts).toHaveLength(2);
    expect(res.body.verificationAttempts[0]).toMatchObject({
      runId: run.id,
      seq: 1,
      mechanism: 'command',
      inputOid: 'oid1',
      verdict: 'pass',
      summary: 'ok',
      output: '',
      mutated: false,
    });
    expect(res.body.verificationAttempts[1]).toMatchObject({
      runId: run.id,
      seq: 2,
      mechanism: 'critic',
      inputOid: 'oid2',
      verdict: 'fail',
      summary: 'nope',
      output: 'details',
      mutated: true,
    });
  });

  it('404s for an unknown run', async () => {
    const res = await server.api('GET', '/api/runs/999999/verification-attempts');
    expect(res.status).toBe(404);
  });
});
