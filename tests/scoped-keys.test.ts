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

describe('read-scoped key (issue #35)', () => {
  let server: TestServer;
  let readToken: string;

  beforeAll(async () => {
    server = await startServer(stubHarness());
    const { body } = await server.api('POST', '/api/keys', { name: 'viz', scope: 'read' });
    readToken = body.token;
  });
  afterAll(async () => {
    await server.close();
  });

  const asRead = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(server.baseUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${readToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return res.status;
  };

  it('allows GET tasks/runs/maps', async () => {
    await server.api('POST', '/api/tasks', { prompt: 'a task', state: 'draft' });
    expect(await asRead('GET', '/api/tasks')).toBe(200);
    expect(await asRead('GET', '/api/tasks/1')).toBe(200);
    expect(await asRead('GET', '/api/tasks/1/runs')).toBe(200);
    expect(await asRead('GET', '/api/maps')).toBe(200); // empty (tracker off), but reachable
  });

  it('blocks every mutation and the operator surface', async () => {
    expect(await asRead('POST', '/api/tasks', { prompt: 'nope' })).toBe(403);
    expect(await asRead('PATCH', '/api/tasks/1', { prompt: 'edit' })).toBe(403);
    expect(await asRead('GET', '/api/keys')).toBe(403);
    expect(await asRead('POST', '/api/keys', { name: 'escalate' })).toBe(403);
    expect(await asRead('PATCH', '/api/config', { agentReview: true })).toBe(403);
    expect(await asRead('GET', '/api/channels')).toBe(403);
    expect(await asRead('GET', '/api/tasks/1/channels')).toBe(403); // per-task channels are operator config
  });

  it('serves /maps as a JSON rollup array', async () => {
    const res = await fetch(`${server.baseUrl}/api/maps`, { headers: { authorization: `Bearer ${readToken}` } });
    expect(await res.json()).toEqual({ maps: [] });
  });

  it('filters the WebSocket to task/run/run-event/run-usage, dropping Conversation and permission traffic', async () => {
    const connect = async (token: string) => {
      const ws = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/ws?token=${token}`);
      const messages: any[] = [];
      ws.addEventListener('message', (ev) => messages.push(JSON.parse(String(ev.data))));
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve);
        ws.addEventListener('error', reject);
      });
      return { messages, close: () => ws.close() };
    };
    const readWs = await connect(readToken);
    const opWs = await connect(server.sessionToken);

    // Synthetic bus events: run_event and run_usage are in the read set (Run
    // traffic), conversation_event is not.
    server.app.ctx.bus.emit('run_event', { id: 1, runId: 1, seq: 1, ts: 0, type: 'lifecycle', payload: {} } as any);
    server.app.ctx.bus.emit('run_usage', {
      runId: 1,
      snapshot: {
        usage: { models: {}, totals: null, toolCalls: {}, source: 'session-log' },
        contextTokens: 1234,
        activity: 'Editing src/foo.ts',
        tree: { id: 's1', name: 'root', model: 'unknown', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: 1234, status: 'active', depth: 0, toolUseId: null, children: [] },
      },
    } as any);
    server.app.ctx.bus.emit('conversation_event', { id: 1, conversationId: 1, seq: 1, ts: 0, type: 'lifecycle', payload: {} } as any);

    // Operator sees all; use conversation_event's arrival as the barrier.
    await waitFor(async () => opWs.messages.some((m) => m.type === 'conversation_event'));
    await waitFor(async () => readWs.messages.some((m) => m.type === 'run_event'));
    // The read key sees live Run usage (ADR 0010), with Cost derived on read.
    const usageMsg = readWs.messages.find((m) => m.type === 'run_usage');
    expect(usageMsg).toMatchObject({ runId: 1, contextTokens: 1234, activity: 'Editing src/foo.ts' });
    expect(usageMsg.cost).not.toBeUndefined();
    expect(readWs.messages.some((m) => m.type === 'conversation_event')).toBe(false);

    readWs.close();
    opWs.close();
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
