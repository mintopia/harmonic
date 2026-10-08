import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, captureRunEnv, cancelRunningTasks, connectFirehose, type TestServer } from './helpers.js';
import { WS_HEARTBEAT_INTERVAL_MS } from '../src/server/ws.js';

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
    expect(await asAgent('POST', `/api/tasks/${done.body.id}/retry`, { guidance: 'x' })).toBe(403);
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

  it('allows GET Workspaces and their Epics but not Epic mutations', async () => {
    expect(await asRead('GET', '/api/workspaces')).toBe(200);
    expect(await asRead('GET', '/api/workspaces/1/epics')).toBe(200);
    expect(await asRead('POST', '/api/workspaces', { name: 'x' })).toBe(403);
    expect(await asRead('POST', '/api/workspaces/1/epics/a/retry')).toBe(403);
    expect(await asRead('GET', '/api/workspaces/1/epics/a/diff/files')).toBe(403);
  });

  it('lists Workspaces as id/name/color only, never their config', async () => {
    const res = await fetch(`${server.baseUrl}/api/workspaces`, { headers: { authorization: `Bearer ${readToken}` } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.workspaces.length).toBeGreaterThan(0);
    expect(body.total).toBe(body.workspaces.length);
    for (const workspace of body.workspaces) {
      expect(Object.keys(workspace).sort()).toEqual(['color', 'id', 'name']);
    }
    expect(JSON.stringify(body)).not.toContain('workingDir');
  });

  it('still serves the full Workspace shape to a full-scope key and the operator session', async () => {
    const { body: key } = await server.api('POST', '/api/keys', { name: 'ops' });
    const viaKey = await (await fetch(`${server.baseUrl}/api/workspaces`, { headers: { authorization: `Bearer ${key.token}` } })).json();
    const viaSession = (await server.api('GET', '/api/workspaces')).body;
    for (const body of [viaKey, viaSession]) {
      expect(body.workspaces[0]).toMatchObject({ workingDir: expect.any(String), trackerEnabled: expect.any(Boolean), exportS3Bucket: null });
    }
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
    const readWs = await connectFirehose(server, readToken);
    const opWs = await connectFirehose(server, server.sessionToken);

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
    const usageMsg = await waitFor(async () =>
      readWs.messages.find((m) => m.type === 'attempt_usage' && m.contextTokens === 1234 && m.cost !== undefined),
    );
    expect(usageMsg).toMatchObject({ attemptId: 1, contextTokens: 1234, activity: 'Editing src/foo.ts' });
    expect(usageMsg.cost).not.toBeUndefined();
    expect(readWs.messages.some((m) => m.type === 'conversation_event')).toBe(false);

    readWs.close();
    opWs.close();
  });

  it('delivers attempt_timeline_changed to a Read Key', async () => {
    const readWs = await connectFirehose(server, readToken);
    server.app.ctx.bus.emit('step_changed', { taskId: 1 });
    await waitFor(async () => readWs.messages.some((m) => m.type === 'attempt_timeline_changed'));
    readWs.close();
  });
});

describe('websocket heartbeat', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const openSilentClient = async (): Promise<{ closed: Promise<void>; terminate: () => void }> => {
    const client = new WsClient(`${server.baseUrl.replace('http', 'ws')}/api/ws`, [server.sessionToken], { autoPong: false });
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      client.once('message', () => resolve());
      client.once('error', reject);
    });
    return { closed, terminate: () => client.terminate() };
  };

  it('sends a heartbeat message every interval', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const ws = await connectFirehose(server);
    vi.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS);
    const beat = await waitFor(async () => ws.messages.find((m) => m.type === 'heartbeat'));
    expect(beat).toMatchObject({ intervalMs: WS_HEARTBEAT_INTERVAL_MS });
    ws.close();
  });

  it('keeps a client that answers pings connected across several intervals', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const client = new WsClient(`${server.baseUrl.replace('http', 'ws')}/api/ws`, [server.sessionToken]);
    let closed = false;
    client.on('close', () => {
      closed = true;
    });
    await new Promise<void>((resolve) => client.once('message', () => resolve()));
    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(closed).toBe(false);
    client.close();
  });

  it('terminates a client that misses a pong, and clears the timer when the socket closes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const before = vi.getTimerCount();
    const client = await openSilentClient();
    expect(vi.getTimerCount()).toBe(before + 1);
    vi.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS);
    vi.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS);
    await client.closed;
    await waitFor(async () => vi.getTimerCount() === before);
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
