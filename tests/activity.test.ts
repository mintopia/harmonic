import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, waitFor, cancelRunningTasks, type TestServer } from './helpers.js';
import type { DeepPartial, AppConfig } from '../src/config.js';

describe('GET /api/activity snapshot (issue #51)', () => {
  let server: TestServer;
  const workDir = mkdtempSync(join(tmpdir(), 'harmonic-activity-work-'));
  const logDir = mkdtempSync(join(tmpdir(), 'harmonic-activity-logs-'));
  const sessionId = 'activity-session-1';

  beforeAll(async () => {
    const slug = workDir.replace(/[^a-zA-Z0-9]/g, '-');
    mkdirSync(join(logDir, slug), { recursive: true });
    writeFileSync(
      join(logDir, slug, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          model: 'claude-opus-4-8',
          usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5 },
        },
      }),
    );

    const config: DeepPartial<AppConfig> = {
      defaults: { workingDir: workDir, isolationMode: 'direct' },
      chat: { harness: 'claude', model: 'stub-model' },
      harnesses: {
        claude: {
          command: process.execPath,
          args: [join(import.meta.dirname, 'stub-harness.mjs')],
          models: ['stub-model'],
          defaultModel: 'stub-model',
          sessionLogDir: logDir,
          env: { STUB_SESSION_ID: sessionId },
        },
      },
    } as DeepPartial<AppConfig>;
    server = await startServer(config);
  });
  afterEach(async () => {
    await cancelRunningTasks(server);
  });
  afterAll(async () => {
    await server.close();
  });

  async function startHangingRun(dir: string = mkdtempSync(join(tmpdir(), 'harmonic-activity-work-'))): Promise<{ taskId: number; attemptId: number }> {
    const scenario = JSON.stringify({
      updates: [{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'pending' }],
      delayMs: 20,
      exit: 'hang',
    });
    const created = await server.api('POST', '/api/tasks', { prompt: scenario, workingDir: dir, isolationMode: 'direct' });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    return { taskId: created.body.id, attemptId: started.body.id };
  }

  it('returns an empty processes array when nothing is running', async () => {
    const { status, body } = await server.api('GET', '/api/activity');
    expect(status).toBe(200);
    expect(body).toEqual({ processes: [], total: 0 });
  });

  it('lists a persisted running Run whose completed Task no longer has a live Runner', async () => {
    const task = (await server.api('POST', '/api/tasks', { prompt: 'wedged merging', workingDir: workDir })).body;
    const run = await server.app.ctx.attempts.create(task.id);
    await server.app.ctx.tasks.setState(task.id, 'done');

    const { body } = await server.api('GET', '/api/activity');
    expect(body.processes).toContainEqual(expect.objectContaining({
      type: 'attempt',
      attemptId: run.id,
      taskId: task.id,
      state: 'running',
      usage: null,
      activity: null,
      tree: null,
    }));
    expect(await server.app.ctx.attempts.countRunning()).toBe(1);
  });

  it("keeps an escalated ticket's settled Run visible on its run rail without counting it as running", async () => {
    const runningBefore = await server.app.ctx.attempts.countRunning();
    const task = (await server.api('POST', '/api/tasks', { prompt: 'escalated', workingDir: workDir })).body;
    const run = await server.app.ctx.attempts.create(task.id);
    await server.app.ctx.attempts.update(run.id, { state: 'failed', reason: 'escalated to human: attempt 3 of 3 failed' });
    await server.app.ctx.tasks.escalate(task.id, 'escalated to human: attempt 3 of 3 failed');

    const { body } = await server.api('GET', `/api/tasks/${task.id}/attempts`);
    expect(body.attempts).toContainEqual(expect.objectContaining({ id: run.id, state: 'failed' }));
    expect(await server.app.ctx.attempts.countRunning()).toBe(runningBefore);
    expect((await server.api('GET', `/api/tasks/${task.id}`)).body.escalationReason).toBe('escalated to human: attempt 3 of 3 failed');
  });

  it('lists a live Run with its Usage snapshot, Process Tree, and derived Cost', async () => {
    const { attemptId } = await startHangingRun(workDir);

    const proc = await waitFor(async () => {
      const { body } = await server.api('GET', '/api/activity');
      return (body.processes as any[]).find(
        (p) => p.type === 'attempt' && p.attemptId === attemptId && p.tree && p.activity === 'Read',
      );
    });

    expect(proc.conversationId).toBeNull();
    expect(typeof proc.taskId).toBe('number');
    expect(typeof proc.workspaceId).toBe('number');
    expect(typeof proc.workspaceName).toBe('string');
    expect(typeof proc.title).toBe('string');
    expect(proc.harness).toBe('claude');
    expect(proc.model).toBe('stub-model');
    expect(proc.state).toBe('running');
    expect(proc.isolation).toBe('direct');
    expect(proc.startedAt).toBeGreaterThan(0);
    expect(proc.trackerRef).toBeNull();
    expect(proc.trackerUrl).toBeNull();
    expect(proc.state).not.toBe('escalated');
    expect(proc.contextWindow).toBeNull();
    expect(proc.usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 });
    expect(proc.contextTokens).toBe(105);
    expect(proc.tree).toMatchObject({ id: sessionId, depth: 0 });
    expect(proc.cost.totalUsd).toBeGreaterThan(0);
  });

  it('keeps a live Runner snapshot available to a reconnecting activity client', async () => {
    const { attemptId } = await startHangingRun(workDir);

    const first = await waitFor(async () => {
      const { body } = await server.api('GET', '/api/activity');
      return (body.processes as any[]).find(
        (process) => process.type === 'attempt' && process.attemptId === attemptId && process.activity === 'Read',
      );
    });
    expect(first.usage.toolCalls).toEqual({ Read: 1 });

    const { body } = await server.api('GET', '/api/activity');
    const reconnected = (body.processes as any[]).find(
      (process) => process.type === 'attempt' && process.attemptId === attemptId,
    );
    expect(reconnected).toMatchObject({ activity: 'Read', tree: { id: sessionId, depth: 0 } });
    expect(reconnected.usage.toolCalls).toEqual({ Read: 1 });
  });

  it('includes a warm Conversation as a chat for an operator; a read key sees Runs only', async () => {
    const { attemptId } = await startHangingRun();
    await waitFor(async () => {
      const { body } = await server.api('GET', '/api/activity');
      return (body.processes as any[]).some((p) => p.type === 'attempt' && p.attemptId === attemptId) || undefined;
    });

    const convo = (await server.api('POST', '/api/conversations', {})).body;
    await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: JSON.stringify({ updates: [], delayMs: 5 }) });
    await waitFor(async () => server.app.ctx.conversationDriver.isWarm(convo.id) || undefined);

    const full = (await server.api('GET', '/api/activity')).body.processes as any[];
    const chat = full.find((p) => p.type === 'chat' && p.conversationId === convo.id);
    expect(chat).toBeTruthy();
    expect(chat.attemptId).toBeNull();
    expect(chat.taskId).toBeNull();
    expect(chat.isolation).toBe('direct');
    expect(chat.tree).toBeNull();
    expect(chat.trackerRef).toBeNull();
    expect(chat.trackerUrl).toBeNull();
    expect(chat.state).not.toBe('escalated');
    expect(typeof chat.title).toBe('string');
    expect(typeof chat.workspaceId).toBe('number');
    expect(typeof chat.workspaceName).toBe('string');
    expect(full.some((p) => p.type === 'attempt')).toBe(true);

    const readToken = (await server.api('POST', '/api/keys', { name: 'viz', scope: 'read' })).body.token;
    const res = await fetch(`${server.baseUrl}/api/activity`, { headers: { authorization: `Bearer ${readToken}` } });
    expect(res.status).toBe(200);
    const readProcs = ((await res.json()) as any).processes as any[];
    expect(readProcs.length).toBeGreaterThan(0);
    expect(readProcs.every((p) => p.type === 'attempt')).toBe(true);
    expect(readProcs.some((p) => p.conversationId !== null)).toBe(false);
  });
});
