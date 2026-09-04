import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, captureRunEnv, cancelRunningTasks, type TestServer } from './helpers.js';

describe('attempt-scoped key restrictions', () => {
  let server: TestServer;
  let scopedToken: string;

  beforeAll(async () => {
    server = await startServer({ ...stubHarness('copilot'), defaults: { harness: 'copilot' } });
    const { env } = await captureRunEnv(server, ['HARMONIC_API_KEY'], { exit: 'hang' });
    scopedToken = env.HARMONIC_API_KEY as string;
  });
  afterAll(async () => {
    await cancelRunningTasks(server);
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
    expect(await asAgent('GET', '/api/tasks/1/attempts')).toBe(200);
  });

  it('denies the operator surface: keys, config, channels', async () => {
    expect(await asAgent('GET', '/api/keys')).toBe(403);
    expect(await asAgent('POST', '/api/keys', { name: 'escalate' })).toBe(403);
    expect(await asAgent('PATCH', '/api/config', { autoRunner: { enabled: true } })).toBe(403);
    expect(await asAgent('PUT', '/api/config', {})).toBe(403);
    expect(await asAgent('GET', '/api/channels')).toBe(403);
    expect(await asAgent('POST', '/api/tasks/1/complete')).toBe(403);
  });

  it('keeps the escalation actions human-only, always (#140 retired the agentReview flag)', async () => {
    const done = await server.api('POST', '/api/tasks', {
      prompt: 'escalation target',
      workingDir: mkdtempSync(join(tmpdir(), 'harmonic-scoped-')),
    });
    await server.app.ctx.tasks.escalate(done.body.id, 'escalated to human: attempt 2 of 2 failed');

    expect(await asAgent('POST', `/api/tasks/${done.body.id}/accept`)).toBe(403);
    expect(await asAgent('POST', `/api/tasks/${done.body.id}/reject`, { guidance: 'x' })).toBe(403);
    expect(await asAgent('POST', `/api/tasks/${done.body.id}/close`)).toBe(403);
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
    await cancelRunningTasks(server);
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
    expect(await asRead('GET', '/api/tasks/1/attempts')).toBe(200);
    expect(await asRead('GET', '/api/maps')).toBe(200);
  });

  it('blocks every mutation and the operator surface', async () => {
    expect(await asRead('POST', '/api/tasks', { prompt: 'nope' })).toBe(403);
    expect(await asRead('PATCH', '/api/tasks/1', { prompt: 'edit' })).toBe(403);
    expect(await asRead('GET', '/api/keys')).toBe(403);
    expect(await asRead('POST', '/api/keys', { name: 'escalate' })).toBe(403);
    expect(await asRead('PATCH', '/api/config', { autoRunner: { enabled: true } })).toBe(403);
    expect(await asRead('GET', '/api/channels')).toBe(403);
    expect(await asRead('GET', '/api/tasks/1/channels')).toBe(403);
  });

  it('serves /maps as a JSON rollup array', async () => {
    const res = await fetch(`${server.baseUrl}/api/maps`, { headers: { authorization: `Bearer ${readToken}` } });
    expect(await res.json()).toEqual({ maps: [], total: 0 });
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

    server.app.ctx.bus.emit('attempt_event', { id: 1, attemptId: 1, seq: 1, ts: 0, type: 'lifecycle', payload: {} } as any);
    server.app.ctx.bus.emit('attempt_usage', {
      attemptId: 1,
      snapshot: {
        usage: { models: {}, totals: null, toolCalls: {}, source: 'session-log' },
        contextTokens: 1234,
        activity: 'Editing src/foo.ts',
        tree: { id: 's1', name: 'root', model: 'unknown', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: 1234, lastTool: null, status: 'active', depth: 0, toolUseId: null, children: [] },
      },
    } as any);
    server.app.ctx.bus.emit('conversation_event', { id: 1, conversationId: 1, seq: 1, ts: 0, type: 'lifecycle', payload: {} } as any);

    await waitFor(async () => opWs.messages.some((m) => m.type === 'conversation_event'));
    await waitFor(async () => readWs.messages.some((m) => m.type === 'attempt_event'));
    const usageMsg = readWs.messages.find((m) => m.type === 'attempt_usage');
    expect(usageMsg).toMatchObject({ attemptId: 1, contextTokens: 1234, activity: 'Editing src/foo.ts' });
    expect(usageMsg.cost).not.toBeUndefined();
    expect(readWs.messages.some((m) => m.type === 'conversation_event')).toBe(false);

    readWs.close();
    opWs.close();
  });
});

describe('scoped key crash recovery', () => {
  it('revokes scoped keys of interrupted runs at boot', async () => {
    const own = await startServer(stubHarness());
    const { env } = await captureRunEnv(own, ['HARMONIC_API_KEY'], { exit: 'hang' });
    const token = env.HARMONIC_API_KEY as string;

    await own.app.close();
    const reopened = await startServer(stubHarness(), { dataDir: own.dataDir });

    const res = await fetch(`${reopened.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    await reopened.close();
  });
});
