import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, writeCopilotUsageDb, type TestServer } from './helpers.js';
import type { DeepPartial, AppConfig } from '../src/config.js';

describe('usage collection retry (log-flush race)', () => {
  const input = (logRoot: string, cwd: string) => ({
    harnessId: 'claude',
    harness: { command: 'x', args: [], env: {}, models: [], defaultModel: 'x', sessionLogDir: logRoot },
    cwd,
    sessionId: 'race-session',
    promptResult: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
    events: [],
  });

  const assistantLine = JSON.stringify({
    type: 'assistant',
    message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 20 } },
  });

  it('re-reads an existing session log until the per-model lines land', async () => {
    const { collectUsageWithRetry } = await import('../src/execution/usage.js');
    const logRoot = mkdtempSync(join(tmpdir(), 'harmonic-race-logs-'));
    const cwd = mkdtempSync(join(tmpdir(), 'harmonic-race-work-'));
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const file = join(logRoot, slug, 'race-session.jsonl');
    mkdirSync(join(logRoot, slug), { recursive: true });
    // The file exists (session started) but the usage lines land late.
    writeFileSync(file, JSON.stringify({ type: 'user', text: 'hi' }));
    setTimeout(() => writeFileSync(file, assistantLine), 50);

    const usage = await collectUsageWithRetry(input(logRoot, cwd), { timeoutMs: 2000, intervalMs: 10 });
    expect(usage?.models['claude-sonnet-5']?.outputTokens).toBe(20);
    expect(usage?.source).toBe('combined');
  });

  it('does not wait when no session log file exists (stub harnesses)', async () => {
    const { collectUsageWithRetry } = await import('../src/execution/usage.js');
    const logRoot = mkdtempSync(join(tmpdir(), 'harmonic-race-logs-'));
    const cwd = mkdtempSync(join(tmpdir(), 'harmonic-race-work-'));
    const before = Date.now();
    const usage = await collectUsageWithRetry(input(logRoot, cwd), { timeoutMs: 2000, intervalMs: 50 });
    expect(Date.now() - before).toBeLessThan(1000);
    expect(usage?.source).toBe('acp');
  });
});

describe('model mismatch (Q7)', () => {
  it("treats a task pinned to 'auto' as matching any observed model", async () => {
    // Copilot's auto router legitimately serves different models per turn
    // (spike, issue 25); the observed models are information in Usage,
    // not a broken pin.
    const { observedModelMismatch } = await import('../src/execution/usage.js');
    const mu = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(observedModelMismatch('auto', { 'gpt-5-mini': mu, 'claude-haiku-4.5': mu })).toBeNull();
    // A real pin that no observed model matches still surfaces.
    expect(observedModelMismatch('gpt-5.4', { 'claude-haiku-4.5': mu })).toEqual(['claude-haiku-4.5']);
  });
});

describe('usage aggregation with AI Units', () => {
  it('mergeUsage sums per-model AI Units and never invents them where absent', async () => {
    const { mergeUsage } = await import('../src/execution/usage.js');
    const mu = (tokens: number, aiUnits?: number) => ({
      inputTokens: tokens,
      outputTokens: tokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ...(aiUnits === undefined ? {} : { aiUnits }),
    });
    const usage = (models: object) =>
      ({ models, totals: null, toolCalls: {}, source: 'session-log' }) as any;

    const merged = mergeUsage([
      usage({ 'claude-haiku-4.5': mu(10, 1.5), 'claude-sonnet-5': mu(5) }),
      usage({ 'claude-haiku-4.5': mu(10, 2.25) }),
    ])!;
    expect(merged.models['claude-haiku-4.5']).toMatchObject({ inputTokens: 20, aiUnits: 3.75 });
    // No source ever reported AI Units for sonnet: the field stays absent.
    expect(merged.models['claude-sonnet-5']).not.toHaveProperty('aiUnits');
  });

  it('mergeUsage carries AI Units into the merged totals (task rollups, stats)', async () => {
    const { mergeUsage } = await import('../src/execution/usage.js');
    const totals = (aiUnits?: number) => ({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      ...(aiUnits === undefined ? {} : { aiUnits }),
    });
    const usage = (t: object) => ({ models: {}, totals: t, toolCalls: {}, source: 'combined' }) as any;

    // Observed spend must survive aggregation (PRODUCT.md: honest numbers).
    expect(mergeUsage([usage(totals(1.5)), usage(totals(2.25))])!.totals).toMatchObject({ aiUnits: 3.75 });
    // A run without AI Units doesn't erase the others'…
    expect(mergeUsage([usage(totals(1.5)), usage(totals())])!.totals).toMatchObject({ aiUnits: 1.5 });
    // …and no run reporting them leaves the field absent, never zero.
    expect(mergeUsage([usage(totals())])!.totals).not.toHaveProperty('aiUnits');
  });
});

describe('Process Tree roll-up (T1)', () => {
  const mu = (input: number, output: number, aiUnits?: number) => ({
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(aiUnits === undefined ? {} : { aiUnits }),
  });
  const node = (over: object): any => ({
    id: 'x',
    name: 'x',
    contextTokens: null,
    status: 'active',
    depth: 0,
    children: [],
    ...over,
  });

  it('rolls a parent + 2 subagents up to the expected per-model total', async () => {
    const { rollUpUsage } = await import('../src/execution/usage.js');
    const tree = node({
      id: 'root',
      model: 'claude-sonnet-5',
      usage: mu(100, 200),
      children: [
        node({ id: 'a', depth: 1, model: 'claude-haiku-4-5', usage: mu(10, 20) }),
        node({ id: 'b', depth: 1, model: 'claude-sonnet-5', usage: mu(5, 7) }),
      ],
    });

    const rolled = rollUpUsage(tree);
    // Same model across parent + subagent sums into one bucket.
    expect(rolled.models['claude-sonnet-5']).toMatchObject({ inputTokens: 105, outputTokens: 207 });
    expect(rolled.models['claude-haiku-4-5']).toMatchObject({ inputTokens: 10, outputTokens: 20 });
    expect(rolled.totals).toMatchObject({ inputTokens: 115, outputTokens: 227 });
  });

  it('prices a rolled-up Usage; an unpriced node in the tree flags incomplete', async () => {
    const { rollUpUsage } = await import('../src/execution/usage.js');
    const { costOfUsages, DEFAULT_PRICES } = await import('../src/execution/pricing.js');

    const priced = rollUpUsage(
      node({
        id: 'root',
        model: 'claude-sonnet-5',
        usage: mu(100, 200),
        children: [node({ id: 'a', depth: 1, model: 'claude-haiku-4-5', usage: mu(10, 20) })],
      }),
    );
    const cost = costOfUsages([priced], DEFAULT_PRICES)!;
    expect(cost.incomplete).toBe(false);
    expect(cost.totalUsd).toBeGreaterThan(0);

    const withUnpriced = rollUpUsage(
      node({
        id: 'root',
        model: 'claude-sonnet-5',
        usage: mu(100, 200),
        children: [node({ id: 'a', depth: 1, model: 'no-such-model', usage: mu(10, 20) })],
      }),
    );
    const partial = costOfUsages([withUnpriced], DEFAULT_PRICES)!;
    expect(partial.incomplete).toBe(true);
    expect(partial.byModel['no-such-model']).toBeNull();
    // The priced model still contributes — a floor, never a fake zero.
    expect(partial.totalUsd).toBeGreaterThan(0);
  });
});

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

  it('codex: reads the per-model breakdown straight off the ACP prompt result', async () => {
    server = await startServer(stubHarness('codex'));
    const { runId } = await runTask({
      harness: 'codex',
      model: 'gpt-5.6-sol',
      prompt: JSON.stringify({
        usage: { totalTokens: 16178, inputTokens: 6189, cachedReadTokens: 9984, outputTokens: 5 },
        _meta: {
          quota: {
            model_usage: [
              {
                model: 'gpt-5.6-sol',
                token_count: { totalTokens: 16178, inputTokens: 6189, cachedInputTokens: 9984, outputTokens: 5 },
              },
            ],
          },
        },
      }),
    });

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.usage.models).toEqual({
      'gpt-5.6-sol': { inputTokens: 6189, outputTokens: 5, cacheReadTokens: 9984, cacheWriteTokens: 0 },
    });
    expect(run.usage.totals.totalTokens).toBe(16178);
    expect(run.usage.source).toBe('combined');
  });

  it('falls back to parsing the native session log for the per-model breakdown', async () => {
    const logRoot = mkdtempSync(join(tmpdir(), 'harmonic-logs-'));
    const workDir = mkdtempSync(join(tmpdir(), 'harmonic-work-'));
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

  it('copilot: derives the per-model breakdown and AI Units from session-store.db', async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), 'harmonic-copilot-home-'));
    const workDir = mkdtempSync(join(tmpdir(), 'harmonic-copilot-work-'));
    const overrides = stubHarness('copilot') as DeepPartial<AppConfig> & {
      harnesses: { copilot: Record<string, unknown> };
    };
    overrides.harnesses.copilot.sessionLogDir = copilotHome;
    overrides.harnesses.copilot.env = { STUB_SESSION_ID: 'copilot-e2e-session' };

    // Native store: <sessionLogDir>/session-store.db, rows keyed by the ACP
    // sessionId. input_tokens is TOTAL input; cache columns omit-when-zero.
    writeCopilotUsageDb(join(copilotHome, 'session-store.db'), [
      { session_id: 'copilot-e2e-session', model: 'gpt-5-mini', input_tokens: 35068, output_tokens: 4539, total_nano_aiu: 1784500000 },
      {
        session_id: 'copilot-e2e-session',
        model: 'claude-haiku-4.5',
        input_tokens: 48503,
        output_tokens: 145,
        cache_write_tokens: 48494,
        total_nano_aiu: 6135150000,
      },
    ]);

    server = await startServer(overrides);
    // The real copilot prompt result is bare — no usage, no _meta (spike Q3).
    const { runId } = await runTask({
      harness: 'copilot',
      model: 'auto',
      workingDir: workDir,
      prompt: JSON.stringify({}),
    });

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.usage.models).toEqual({
      'gpt-5-mini': { inputTokens: 35068, outputTokens: 4539, cacheReadTokens: 0, cacheWriteTokens: 0, aiUnits: 1.7845 },
      'claude-haiku-4.5': { inputTokens: 9, outputTokens: 145, cacheReadTokens: 0, cacheWriteTokens: 48494, aiUnits: 6.13515 },
    });
    expect(run.usage.totals.aiUnits).toBeCloseTo(7.91965, 10);
    expect(run.usage.source).toBe('session-log');
    // Both observed serving models are priced out of the box.
    expect(run.cost.incomplete).toBe(false);
    expect(run.cost.totalUsd).toBeGreaterThan(0);
    // 'auto' delegated the choice: observed models are information, not a
    // contradiction…
    const events = (await server.api('GET', `/api/runs/${runId}/events`)).body.events;
    expect(events.find((e: any) => e.payload?.event === 'model_mismatch')).toBeUndefined();

    // …but a real pin the plan silently ignored (auto-only plans accept
    // set_model and route anyway, spike Q2) IS surfaced on the run.
    const pinned = await runTask({
      harness: 'copilot',
      model: 'gpt-5.4',
      workingDir: workDir,
      prompt: JSON.stringify({}),
    });
    const pinnedEvents = (await server.api('GET', `/api/runs/${pinned.runId}/events`)).body.events;
    expect(pinnedEvents.find((e: any) => e.payload?.event === 'model_mismatch')?.payload).toMatchObject({
      expected: 'gpt-5.4',
      observed: expect.arrayContaining(['gpt-5-mini', 'claude-haiku-4.5']),
    });
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
    // Per-day chart series: one bucket at today's local midnight.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    expect(all.body.series).toHaveLength(1);
    expect(all.body.series[0].day).toBe(midnight.getTime());

    const empty = await server.api('GET', `/api/stats?from=${Date.now() + 60_000}&to=${Date.now() + 120_000}`);
    expect(empty.body.runCount).toBe(0);
    expect(empty.body.totals).toBeNull();
    expect(empty.body.series).toEqual([]);
  });
});
