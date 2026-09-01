import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startServer, stubHarness, type TestServer } from './helpers.js';

describe('GET /api/attempts/:id/verification-attempts (issue #169)', () => {
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
    const run = await ctx().attempts.create(task.id);
    const attempt = run;

    await ctx().verificationAttempts.append(attempt.id, {
      mechanism: 'command',
      inputOid: 'oid1',
      verdict: 'pass',
      summary: 'ok',
      output: '',
    });
    await ctx().verificationAttempts.append(attempt.id, {
      mechanism: 'critic',
      inputOid: 'oid2',
      verdict: 'fail',
      summary: 'nope',
      output: 'details',
    });

    const res = await server.api('GET', `/api/attempts/${run.id}/verification-attempts`);
    expect(res.status).toBe(200);
    expect(res.body.verificationAttempts).toHaveLength(2);
    expect(res.body.verificationAttempts[0]).toMatchObject({
      attemptId: attempt.id,
      seq: 1,
      mechanism: 'command',
      inputOid: 'oid1',
      verdict: 'pass',
      summary: 'ok',
      output: '',
    });
    expect(res.body.verificationAttempts[1]).toMatchObject({
      attemptId: attempt.id,
      seq: 2,
      mechanism: 'critic',
      inputOid: 'oid2',
      verdict: 'fail',
      summary: 'nope',
      output: 'details',
    });
    expect(res.body.verifierStatuses).toEqual(expect.arrayContaining([
      { mechanism: 'command', state: 'passed', reason: null },
      { mechanism: 'critic', state: 'failed', reason: null },
    ]));
  });

  it('reconciles recorded attempts with configured verifier statuses', async () => {
    const configured = await startServer({
      ...stubHarness(),
      verify: {
        commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }],
        review: { enabled: true, prompt: 'Review the diff.', model: 'stub-model' },
      },
    });
    try {
      const created = await configured.api('POST', '/api/tasks', { prompt: 'verification status target' });
      const task = await configured.app.ctx.tasks.get(created.body.id);
      const run = await configured.app.ctx.attempts.create(task.id);
      const attempt = run;
      await configured.app.ctx.verificationAttempts.append(attempt.id, {
        mechanism: 'critic',
        inputOid: 'oid1',
        verdict: 'pass',
        summary: 'looks good',
        output: '',
        });

      const res = await configured.api('GET', `/api/attempts/${run.id}/verification-attempts`);

      expect(res.status).toBe(200);
      expect(res.body.verifierStatuses).toEqual([
        { mechanism: 'command', state: 'skipped', reason: 'No command verification attempt was recorded for this run.', commands: ['npm test'] },
        { mechanism: 'critic', state: 'passed', reason: null },
      ]);
    } finally {
      await configured.close();
    }
  });

  it('reconciles recorded attempts with configured verifier statuses', async () => {
    const configured = await startServer({
      ...stubHarness(),
      verify: {
        commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }],
        review: { enabled: true, prompt: 'Review the diff.', model: 'stub-model' },
      },
    });
    try {
      const created = await configured.api('POST', '/api/tasks', { prompt: 'verification status target' });
      const task = await configured.app.ctx.tasks.get(created.body.id);
      const run = await configured.app.ctx.attempts.create(task.id);
      const attempt = run;
      await configured.app.ctx.verificationAttempts.append(attempt.id, {
        mechanism: 'critic',
        inputOid: 'oid1',
        verdict: 'pass',
        summary: 'looks good',
        output: '',
        });

      const res = await configured.api('GET', `/api/attempts/${run.id}/verification-attempts`);

      expect(res.status).toBe(200);
      expect(res.body.verifierStatuses).toEqual([
        { mechanism: 'command', state: 'skipped', reason: 'No command verification attempt was recorded for this run.', commands: ['npm test'] },
        { mechanism: 'critic', state: 'passed', reason: null },
      ]);
    } finally {
      await configured.close();
    }
  });

  it('404s for an unknown run', async () => {
    const res = await server.api('GET', '/api/attempts/999999/verification-attempts');
    expect(res.status).toBe(404);
  });
});
