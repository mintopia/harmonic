import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

describe('attempt timeline API', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer(stubHarness());
  });

  afterEach(async () => {
    await server.close();
  });

  it('serves the same ordered timeline over REST and WebSocket', async () => {
    const messages: unknown[] = [];
    const socket = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/ws?token=${server.sessionToken}`);
    socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', reject);
    });

    const created = await server.api('POST', '/api/tasks', { prompt: 'timeline parity' });
    const attempt = await server.app.ctx.attempts.ensureForRun(created.body.id, 1, 10);
    const implementation = await server.app.ctx.attempts.createStep(attempt.id, {
      type: 'implementation',
      logLocator: 'transcript:/tmp/session.jsonl',
    });
    await server.app.ctx.attempts.updateStep(implementation.id, {
      state: 'passed',
      verdict: 'pass',
      startedAt: 11,
      endedAt: 12,
    });
    await server.app.ctx.attempts.setContinuation(attempt.id, {
      path: 'new-session-condensed',
      reason: 'context-tokens',
      contextTokens: 250_000,
      contextReuseTokenLimit: 200_000,
      lastActiveAt: 9,
      lastActiveAgeMs: 1,
      warmWindowMs: 60 * 60 * 1000,
    });
    const verification = await server.app.ctx.attempts.createStep(attempt.id, {
      type: 'verification',
      command: 'npm test',
      logLocator: 'verification_attempt:31',
    });
    await server.app.ctx.attempts.updateStep(verification.id, {
      state: 'passed',
      verdict: 'pass',
      startedAt: 13,
      endedAt: 14,
    });
    const run = await server.app.ctx.runs.create(created.body.id);
    await server.app.ctx.verificationAttempts.append(run.id, {
      mechanism: 'command', inputOid: 'verified-sha', verdict: 'pass', summary: 'checks passed', output: '',
    });
    // `verifiedSha` now derives from the passing verification attempt above
    // (ADR-0001 #388 S-E: the `verified-head` fact was a redundant second
    // copy); `escalate` closes the Attempt with its disposition-kind reason,
    // the same write `RunSettleCoordinator.settle` makes.
    await server.app.ctx.attempts.finish(attempt.id, 'escalated', 15, undefined, 'escalate');
    server.app.ctx.bus.emit('run_changed', run);
    await waitFor(async () => messages.find(
      (message) => typeof message === 'object'
        && message !== null
        && Reflect.get(message, 'type') === 'attempt_timeline_changed'
        && Reflect.get(message, 'taskId') === created.body.id,
    ));

    const event = messages.find(
      (message) => typeof message === 'object'
        && message !== null
        && Reflect.get(message, 'type') === 'attempt_timeline_changed'
        && Reflect.get(message, 'taskId') === created.body.id,
    );
    const rest = await server.api('GET', `/api/tasks/${created.body.id}/attempts`);

    expect(rest.status).toBe(200);
    expect(Reflect.get(event!, 'attempts')).toEqual(rest.body.attempts);
    expect(rest.body.attempts[0].steps.map((step: { position: number }) => step.position)).toEqual([1, 2]);
    expect(rest.body.attempts[0].verifiedSha).toBe('verified-sha');
    expect(rest.body.attempts[0].escalationReason).toBe('escalate');
    expect(rest.body.attempts[0].continuation).toMatchObject({ path: 'new-session-condensed', contextTokens: 250_000 });
    // The recorded 'command' verification attempt (seeded above for
    // `verifiedSha`) is itself ground truth that a command verifier ran —
    // it reconciles to 'passed', not the config-derived 'disabled'.
    expect(rest.body.attempts[0].verifierStatuses).toEqual([
      { mechanism: 'command', state: 'passed', reason: null },
      { mechanism: 'critic', state: 'disabled', reason: 'Critic verification is disabled.' },
    ]);
    expect(rest.body.attempts[0].steps[1]).not.toHaveProperty('verifiedSha');
    socket.close();
  });
});
