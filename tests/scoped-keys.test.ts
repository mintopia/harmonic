import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

describe('run-scoped key restrictions', () => {
  let server: TestServer;
  let scopedToken: string;

  beforeAll(async () => {
    server = await startServer(stubHarness());
    // Capture a scoped key by having a hanging run echo its env, then keep
    // the run alive so the key stays valid while we probe with it.
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ echoEnv: ['HARMONIC_API_KEY'], exit: 'hang' }),
    });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    const echo = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${started.body.id}/events`);
      return body.events.find((e: any) => e.payload?.content?.text?.startsWith('{'));
    });
    scopedToken = JSON.parse(echo.payload.content.text).HARMONIC_API_KEY;
  });
  afterAll(async () => {
    await server.close();
  });

  const asAgent = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(server.baseUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${scopedToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return res.status;
  };

  it('allows the agent task surface: task CRUD, dependencies, runs, events', async () => {
    expect(await asAgent('GET', '/api/tasks')).toBe(200);
    expect(await asAgent('POST', '/api/tasks', { prompt: 'follow-up', state: 'draft' })).toBe(201);
    expect(await asAgent('GET', '/api/tasks/1/runs')).toBe(200);
  });

  it('denies the operator surface: keys, config, channels', async () => {
    expect(await asAgent('GET', '/api/keys')).toBe(403);
    expect(await asAgent('POST', '/api/keys', { name: 'escalate' })).toBe(403);
    expect(await asAgent('PATCH', '/api/config', { agentReview: true })).toBe(403);
    expect(await asAgent('PUT', '/api/config', {})).toBe(403);
    expect(await asAgent('GET', '/api/channels')).toBe(403);
  });

  it('keeps the review gate human unless agent-review is enabled', async () => {
    // A finished task to review.
    const done = await server.api('POST', '/api/tasks', { prompt: 'review target' });
    await server.api('POST', `/api/tasks/${done.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${done.body.id}`)).body.state === 'awaiting-review');

    expect(await asAgent('POST', `/api/tasks/${done.body.id}/accept`)).toBe(403);
    expect(await asAgent('POST', `/api/tasks/${done.body.id}/reject`, { feedback: 'x' })).toBe(403);

    await server.api('PATCH', '/api/config', { agentReview: true });
    expect(await asAgent('POST', `/api/tasks/${done.body.id}/accept`)).toBe(200);
    await server.api('PATCH', '/api/config', { agentReview: false });
  });

});

describe('scoped key crash recovery', () => {
  it('revokes scoped keys of interrupted runs at boot', async () => {
    const own = await startServer(stubHarness());
    const created = await own.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ echoEnv: ['HARMONIC_API_KEY'], exit: 'hang' }),
    });
    const started = await own.api('POST', `/api/tasks/${created.body.id}/run`);
    const echo = await waitFor(async () => {
      const { body } = await own.api('GET', `/api/runs/${started.body.id}/events`);
      return body.events.find((e: any) => e.payload?.content?.text?.startsWith('{'));
    });
    const token = JSON.parse(echo.payload.content.text).HARMONIC_API_KEY;

    await own.app.close();
    const reopened = await startServer(stubHarness(), { dataDir: own.dataDir });

    const res = await fetch(`${reopened.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    await reopened.close();
  });
});
