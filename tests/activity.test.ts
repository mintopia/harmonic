import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, waitFor, cancelRunningTasks, type TestServer } from './helpers.js';
import type { DeepPartial, AppConfig } from '../src/config.js';

/**
 * The instance-wide Activity snapshot (issue #51, ADR 0010): `GET /api/activity`
 * reads persisted capacity-consuming Runs and warm Conversations, joining a Run
 * with its latest live Usage / Process Tree when a Runner is registered. A
 * hanging stub run keeps a live Runner while we probe telemetry; a warm
 * Conversation keeps a chat process. A read (viz) key reaches the endpoint but
 * sees Runs only.
 */
describe('GET /api/activity snapshot (issue #51)', () => {
  let server: TestServer;
  const workDir = mkdtempSync(join(tmpdir(), 'harmonic-activity-work-'));
  const logDir = mkdtempSync(join(tmpdir(), 'harmonic-activity-logs-'));
  const sessionId = 'activity-session-1';

  beforeAll(async () => {
    // A Claude transcript at the path the collector derives (slug(cwd)/<id>.jsonl),
    // so a live run's snapshot has a real Process Tree to parse.
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
      // Chat default tracks the stub harness so its model stays valid (config
      // schema enforces chat.model ∈ the harness's models).
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
    // Release the process-global Claude harness lock (#237) that this file's
    // hanging Runs would otherwise hold into the next test.
    await cancelRunningTasks(server);
  });
  afterAll(async () => {
    await server.close();
  });

  /**
   * Start a run that emits one tool call then hangs — stays in `Runner.active`
   * (and never settles, so never releases its Work Context lease). Each call
   * gets its own workingDir by default so independent tests' hanging runs
   * don't contend for the same direct-mode lease (issue #119) — pass `dir`
   * explicitly only when the test needs the pre-written transcript under
   * `workDir`'s slug.
   */
  async function startHangingRun(dir: string = mkdtempSync(join(tmpdir(), 'harmonic-activity-work-'))): Promise<{ taskId: number; runId: number }> {
    const scenario = JSON.stringify({
      updates: [{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'pending' }],
      delayMs: 20,
      exit: 'hang',
    });
    const created = await server.api('POST', '/api/tasks', { prompt: scenario, workingDir: dir, isolationMode: 'direct' });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    return { taskId: created.body.id, runId: started.body.id };
  }

  it('returns an empty processes array when nothing is running', async () => {
    const { status, body } = await server.api('GET', '/api/activity');
    expect(status).toBe(200);
    expect(body).toEqual({ processes: [], total: 0 });
  });

  it('lists a persisted running Run whose completed Task no longer has a live Runner', async () => {
    const task = (await server.api('POST', '/api/tasks', { prompt: 'wedged landing', workingDir: workDir })).body;
    const run = await server.app.ctx.runs.create(task.id);
    await server.app.ctx.tasks.setState(task.id, 'done');

    const { body } = await server.api('GET', '/api/activity');
    expect(body.processes).toContainEqual(expect.objectContaining({
      type: 'run',
      runId: run.id,
      taskId: task.id,
      state: 'running',
      usage: null,
      activity: null,
      tree: null,
    }));
    expect(await server.app.ctx.runs.countRunning()).toBe(1);
  });

  it("keeps an escalated ticket's settled Run visible on its run rail without counting it as running", async () => {
    const runningBefore = await server.app.ctx.runs.countRunning();
    const task = (await server.api('POST', '/api/tasks', { prompt: 'escalated', workingDir: workDir })).body;
    const run = await server.app.ctx.runs.create(task.id);
    await server.app.ctx.runs.update(run.id, { state: 'failed', phase: 'terminal', reason: 'escalated to human: attempt 3 of 3 failed' });
    await server.app.ctx.tasks.escalate(task.id, 'escalated to human: attempt 3 of 3 failed');

    const { body } = await server.api('GET', `/api/tasks/${task.id}/runs`);
    expect(body.runs).toContainEqual(expect.objectContaining({ id: run.id, state: 'failed', phase: 'terminal' }));
    expect(await server.app.ctx.runs.countRunning()).toBe(runningBefore);
    expect((await server.api('GET', `/api/tasks/${task.id}`)).body.escalationReason).toBe('escalated to human: attempt 3 of 3 failed');
  });

  it('lists a live Run with its Usage snapshot, Process Tree, and derived Cost', async () => {
    const { runId } = await startHangingRun(workDir); // the dir with the pre-written transcript

    const proc = await waitFor(async () => {
      const { body } = await server.api('GET', '/api/activity');
      return (body.processes as any[]).find(
        (p) => p.type === 'run' && p.runId === runId && p.tree && p.activity === 'Read',
      );
    });

    expect(proc.conversationId).toBeNull();
    expect(typeof proc.taskId).toBe('number');
    expect(typeof proc.workspaceId).toBe('number');
    expect(typeof proc.workspaceName).toBe('string'); // names its own Workspace (issue #52)
    expect(typeof proc.title).toBe('string'); // derived from the Task prompt (issue #52)
    expect(proc.harness).toBe('claude');
    expect(proc.model).toBe('stub-model');
    expect(proc.state).toBe('running');
    expect(proc.isolation).toBe('direct');
    expect(proc.startedAt).toBeGreaterThan(0);
    expect(proc.trackerRef).toBeNull(); // native task, not a mirrored ticket
    expect(proc.trackerUrl).toBeNull(); // native task has no ticket deep-link (issue #55)
    expect(proc.state).not.toBe('escalated'); // afk run, not escalated (issue #52)
    expect(proc.contextWindow).toBeNull(); // stub-model has no configured window
    expect(proc.usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 });
    expect(proc.contextTokens).toBe(105); // input + cache read
    expect(proc.tree).toMatchObject({ id: sessionId, depth: 0 });
    expect(proc.cost.totalUsd).toBeGreaterThan(0);
  });

  it('includes a warm Conversation as a chat for an operator; a read key sees Runs only', async () => {
    // A live run so the read-key result is non-empty (Runs are in the read set).
    const { runId } = await startHangingRun();
    await waitFor(async () => {
      const { body } = await server.api('GET', '/api/activity');
      return (body.processes as any[]).some((p) => p.type === 'run' && p.runId === runId) || undefined;
    });

    // A warm Conversation stays in the active registry after its Turn finishes.
    const convo = (await server.api('POST', '/api/conversations', {})).body;
    await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: JSON.stringify({ updates: [], delayMs: 5 }) });
    await waitFor(async () => server.app.ctx.conversationDriver.isWarm(convo.id) || undefined);

    // Operator (cookie) sees both sources.
    const full = (await server.api('GET', '/api/activity')).body.processes as any[];
    const chat = full.find((p) => p.type === 'chat' && p.conversationId === convo.id);
    expect(chat).toBeTruthy();
    expect(chat.runId).toBeNull();
    expect(chat.taskId).toBeNull();
    expect(chat.isolation).toBe('direct'); // Conversations are direct-only (ADR-0006)
    expect(chat.tree).toBeNull(); // no live tailer for Conversations
    expect(chat.trackerRef).toBeNull();
    expect(chat.trackerUrl).toBeNull(); // Conversations have no ticket deep-link (issue #55)
    expect(chat.state).not.toBe('escalated'); // Conversations don't carry the afk-escalation flag (issue #52)
    expect(typeof chat.title).toBe('string');
    expect(typeof chat.workspaceId).toBe('number');
    expect(typeof chat.workspaceName).toBe('string');
    expect(full.some((p) => p.type === 'run')).toBe(true);

    // A read (viz) key reaches the endpoint (not 403) but sees Runs only.
    const readToken = (await server.api('POST', '/api/keys', { name: 'viz', scope: 'read' })).body.token;
    const res = await fetch(`${server.baseUrl}/api/activity`, { headers: { authorization: `Bearer ${readToken}` } });
    expect(res.status).toBe(200);
    const readProcs = ((await res.json()) as any).processes as any[];
    expect(readProcs.length).toBeGreaterThan(0);
    expect(readProcs.every((p) => p.type === 'run')).toBe(true);
    expect(readProcs.some((p) => p.conversationId !== null)).toBe(false);
  });
});
