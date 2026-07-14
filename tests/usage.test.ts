import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import type { DeepPartial, AppConfig } from '../src/config.js';

describe('usage collection and statistics', () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.close();
  });

  const runTask = async (input: object): Promise<{ taskId: number; runId: number }> => {
    const created = await server.api('POST', '/api/tasks', input);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${created.body.id}`);
      return body.state === 'awaiting-review' || body.state === 'failed';
    });
    return { taskId: created.body.id, runId: started.body.id };
  };

  it('collects aggregate usage from the ACP prompt result and tallies tool calls from events', async () => {
    server = await startServer(stubHarness());
    const { runId } = await runTask({
      prompt: JSON.stringify({
        updates: [
          { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write', kind: 'edit', status: 'pending' },
          { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Write', kind: 'edit', status: 'pending' },
          { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Read', kind: 'read', status: 'pending' },
        ],
        usage: { inputTokens: 55, outputTokens: 1403, cachedReadTokens: 385226, cachedWriteTokens: 39741, totalTokens: 426425 },
      }),
    });

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.usage.totals).toEqual({
      inputTokens: 55,
      outputTokens: 1403,
      cacheReadTokens: 385226,
      cacheWriteTokens: 39741,
      totalTokens: 426425,
    });
    expect(run.usage.toolCalls).toEqual({ Write: 2, Read: 1 });
    expect(run.usage.source).toBe('acp');
  });

  it('falls back to parsing the native session log for the per-model breakdown', async () => {
    const logRoot = mkdtempSync(join(tmpdir(), 'agentdeck-logs-'));
    const workDir = mkdtempSync(join(tmpdir(), 'agentdeck-work-'));
    const overrides = stubHarness() as DeepPartial<AppConfig> & {
      harnesses: { claude: Record<string, unknown> };
    };
    overrides.harnesses.claude.sessionLogDir = logRoot;
    overrides.harnesses.claude.env = { STUB_SESSION_ID: 'fixed-session' };

    // Claude Code convention: <logRoot>/<slugified-cwd>/<sessionId>.jsonl
    const slug = workDir.replace(/[^a-zA-Z0-9]/g, '-');
    mkdirSync(join(logRoot, slug), { recursive: true });
    const line = (id: string, model: string, usage: object) =>
      JSON.stringify({ type: 'assistant', message: { id, model, usage } });
    writeFileSync(
      join(logRoot, slug, 'fixed-session.jsonl'),
      [
        line('msg1', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 }),
        // duplicate of msg1 (Claude Code repeats usage lines per chunk) — must count once
        line('msg1', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 }),
        line('msg2', 'claude-haiku-4-5', { input_tokens: 3, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 1 }),
        JSON.stringify({ type: 'user', text: 'not an assistant line' }),
      ].join('\n'),
    );

    server = await startServer(overrides);
    const { runId } = await runTask({ prompt: JSON.stringify({}), workingDir: workDir });

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.usage.models).toEqual({
      'claude-sonnet-5': { inputTokens: 10, outputTokens: 100, cacheWriteTokens: 5, cacheReadTokens: 7 },
      'claude-haiku-4-5': { inputTokens: 3, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 1 },
    });
    expect(run.usage.source).toBe('session-log');
  });

  it('reports usage as unavailable — not zero — when neither source exists', async () => {
    server = await startServer(stubHarness());
    const { runId } = await runTask({ prompt: JSON.stringify({}) });
    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.usage).toBeNull();
  });

  it('aggregates usage per task across runs, including retries', async () => {
    server = await startServer(stubHarness());
    const usageScenario = JSON.stringify({
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      exit: 'clean',
    });
    const { taskId } = await runTask({ prompt: usageScenario });
    await server.api('POST', `/api/tasks/${taskId}/reject`, { feedback: 'again' });
    await server.api('POST', `/api/tasks/${taskId}/requeue`);
    await server.api('POST', `/api/tasks/${taskId}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'awaiting-review');

    const agg = await server.api('GET', `/api/tasks/${taskId}/usage`);
    expect(agg.status).toBe(200);
    expect(agg.body.totals.inputTokens).toBe(20);
    expect(agg.body.totals.outputTokens).toBe(40);
    expect(agg.body.runCount).toBe(2);
  });

  it('serves stats aggregated over a time range', async () => {
    server = await startServer(stubHarness());
    await runTask({
      prompt: JSON.stringify({
        updates: [{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', kind: 'execute', status: 'pending' }],
        usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
      }),
    });

    const all = await server.api('GET', `/api/stats?from=0&to=${Date.now() + 1000}`);
    expect(all.status).toBe(200);
    expect(all.body.totals.inputTokens).toBe(5);
    expect(all.body.toolCalls).toEqual({ Bash: 1 });
    expect(all.body.runCount).toBe(1);

    const empty = await server.api('GET', `/api/stats?from=${Date.now() + 60_000}&to=${Date.now() + 120_000}`);
    expect(empty.body.runCount).toBe(0);
    expect(empty.body.totals).toBeNull();
  });
});
