import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { startServer, waitFor, type TestServer } from './helpers.js';
import { attempts } from '../src/db/schema.js';
import type { DeepPartial, AppConfig } from '../src/config.js';

describe('live attempt_usage firehose (ADR 0010)', () => {
  let server: TestServer;
  const workDir = mkdtempSync(join(tmpdir(), 'harmonic-live-work-'));
  const logDir = mkdtempSync(join(tmpdir(), 'harmonic-live-logs-'));
  const sessionId = 'live-session-1';

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
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read' }],
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
          models: [
            { id: 'stub-model' },
            { id: 'claude-opus-4-8', price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
          ],
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
    const attemptId = started.body.id;

    const msg = await waitFor(async () => messages.find((m) => m.type === 'attempt_usage' && m.attemptId === attemptId));
    expect(msg.usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 });
    expect(msg.contextTokens).toBe(105);
    expect(msg.tree).toMatchObject({ id: sessionId, depth: 0, lastTool: 'Read' });
    expect(msg.cost.totalUsd).toBeGreaterThan(0);
    expect(msg.activity).toBe('Read');
    expect(msg.usage.toolCalls).toEqual({ Read: 1 });
    expect(msg.usage.agents.root).toMatchObject({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 });

    const persisted = await waitFor(async () => {
      const row = await server.app.ctx.asyncDb.read((d) =>
        d.select({ live: attempts.liveUsage }).from(attempts).where(eq(attempts.id, attemptId)).get(),
      );
      return row?.live ?? false;
    });
    expect(JSON.parse(persisted).tree.id).toBe(sessionId);

    ws.close();
  });
});
