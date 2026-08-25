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
    const implementation = await server.app.ctx.attempts.createTask(attempt.id, {
      type: 'implementation',
      logLocator: 'transcript:/tmp/session.jsonl',
    });
    await server.app.ctx.attempts.updateTask(implementation.id, {
      state: 'passed',
      verdict: 'pass',
      startedAt: 11,
      endedAt: 12,
    });
    const verification = await server.app.ctx.attempts.createTask(attempt.id, {
      type: 'verification',
      command: 'npm test',
      logLocator: 'verification_attempt:31',
    });
    await server.app.ctx.attempts.updateTask(verification.id, {
      state: 'passed',
      verdict: 'pass',
      startedAt: 13,
      endedAt: 14,
    });
    await server.app.ctx.attempts.finish(attempt.id, 'passed', 15);

    const run = await server.app.ctx.runs.create(created.body.id);
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
    expect(rest.body.attempts[0].tasks.map((task: { position: number }) => task.position)).toEqual([1, 2]);
    socket.close();
  });
});
