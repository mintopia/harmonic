import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { startServer, waitFor, type TestServer } from './helpers.js';
import { runs } from '../src/db/schema.js';
import type { DeepPartial, AppConfig } from '../src/config.js';

/**
 * End-to-end: a running Claude harness tails its native session log and the
 * server streams a `run_usage` firehose event carrying the live snapshot
 * (ADR 0010). The log is pre-written so `parse()` has something to read; the
 * tailer's final flush on stop guarantees at least one event even for a quick
 * run.
 */
describe('live run_usage firehose (ADR 0010)', () => {
  let server: TestServer;
  const workDir = mkdtempSync(join(tmpdir(), 'harmonic-live-work-'));
  const logDir = mkdtempSync(join(tmpdir(), 'harmonic-live-logs-'));
  const sessionId = 'live-session-1';

  beforeAll(async () => {
    // A Claude transcript at the path the collector derives (slug(cwd)/<id>.jsonl).
    const slug = workDir.replace(/[^a-zA-Z0-9]/g, '-');
    mkdirSync(join(logDir, slug), { recursive: true });
    writeFileSync(
      join(logDir, slug, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5 } },
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
  afterAll(async () => {
    await server.close();
  });

  it('streams a snapshot with rolled-up Usage, context fill, activity, and a Process Tree', async () => {
    const ws = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/ws?token=${server.sessionToken}`);
    const messages: any[] = [];
    ws.addEventListener('message', (ev) => messages.push(JSON.parse(String(ev.data))));
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });

    const scenario = JSON.stringify({
      updates: [{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'pending' }],
      delayMs: 30,
    });
    const created = await server.api('POST', '/api/tasks', { prompt: scenario, workingDir: workDir, isolationMode: 'direct' });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    const runId = started.body.id;

    const msg = await waitFor(async () => messages.find((m) => m.type === 'run_usage' && m.runId === runId));
    expect(msg.usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 });
    expect(msg.contextTokens).toBe(105); // input + cache read
    expect(msg.tree).toMatchObject({ id: sessionId, depth: 0 });
    expect(msg.cost.totalUsd).toBeGreaterThan(0);
    // The tool call drove the current-activity line.
    expect(msg.activity).toBe('Read');
    // The live snapshot carries the running tool tally (issue #100): the Board
    // ticks "· N tools" off this, so an empty map would freeze the count at
    // zero. `parse()` alone yields no tally — it is folded in from the events.
    expect(msg.usage.toolCalls).toEqual({ Read: 1 });
    // Per-agent breakdown rides the snapshot too: this run is root-only.
    expect(msg.usage.agents.root).toMatchObject({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 });

    // Always persisted on finish (ADR 0010): the row's snapshot survives a
    // restart. Guards the finalize→stop flush ordering the reviewer flagged.
    const persisted = await waitFor(async () => {
      const row = await server.app.ctx.asyncDb.read((d) =>
        d.select({ live: runs.liveUsage }).from(runs).where(eq(runs.id, runId)).get(),
      );
      return row?.live ?? false;
    });
    expect(JSON.parse(persisted).tree.id).toBe(sessionId);

    ws.close();
  });
});
