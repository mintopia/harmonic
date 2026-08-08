import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, waitFor, type TestServer } from './helpers.js';
import type { DeepPartial, AppConfig } from '../src/config.js';

/**
 * The instance-wide Activity snapshot (issue #51, ADR 0010): `GET /api/activity`
 * reads the in-memory registries (`Runner.active` + `ConversationDriver.active`)
 * and joins each with its latest Usage / Process Tree. A hanging stub run keeps
 * a live process in the registry while we probe it; a warm Conversation keeps a
 * chat process. A read (viz) key reaches the endpoint but sees Runs only.
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
  afterAll(async () => {
    await server.close();
  });

  /** Start a run that emits one tool call then hangs — stays in `Runner.active`. */
  async function startHangingRun(): Promise<number> {
    const scenario = JSON.stringify({
      updates: [{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'pending' }],
      delayMs: 20,
      exit: 'hang',
    });
    const created = await server.api('POST', '/api/tasks', { prompt: scenario, workingDir: workDir, isolationMode: 'direct' });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    return started.body.id;
  }

  it('returns an empty processes array when nothing is running', async () => {
    const { status, body } = await server.api('GET', '/api/activity');
    expect(status).toBe(200);
    expect(body).toEqual({ processes: [] });
  });

  it('lists a live Run with its Usage snapshot, Process Tree, and derived Cost', async () => {
    const runId = await startHangingRun();

    const proc = await waitFor(async () => {
      const { body } = await server.api('GET', '/api/activity');
      return (body.processes as any[]).find(
        (p) => p.type === 'run' && p.runId === runId && p.tree && p.activity === 'Read',
      );
    });

    expect(proc.conversationId).toBeNull();
    expect(typeof proc.taskId).toBe('number');
    expect(typeof proc.workspaceId).toBe('number');
    expect(proc.harness).toBe('claude');
    expect(proc.model).toBe('stub-model');
    expect(proc.state).toBe('running');
    expect(proc.isolation).toBe('direct');
    expect(proc.startedAt).toBeGreaterThan(0);
    expect(proc.trackerRef).toBeNull(); // native task, not a mirrored ticket
    expect(proc.usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 });
    expect(proc.contextTokens).toBe(105); // input + cache read
    expect(proc.tree).toMatchObject({ id: sessionId, depth: 0 });
    expect(proc.cost.totalUsd).toBeGreaterThan(0);
  });

  it('includes a warm Conversation as a chat for an operator; a read key sees Runs only', async () => {
    // A live run so the read-key result is non-empty (Runs are in the read set).
    const runId = await startHangingRun();
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
    expect(typeof chat.workspaceId).toBe('number');
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
