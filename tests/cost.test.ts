import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import type { DeepPartial, AppConfig } from '../src/config.js';
import { costOfUsages, DEFAULT_PRICES, resolvePrices } from '../src/execution/pricing.js';
import type { ModelUsage, RunUsage } from '../src/execution/usage.js';

const mu = (tokens: number): ModelUsage => ({
  inputTokens: tokens,
  outputTokens: tokens,
  cacheReadTokens: tokens,
  cacheWriteTokens: tokens,
});

const usageOf = (models: Record<string, ModelUsage>): RunUsage => ({
  models,
  totals: null,
  toolCalls: {},
  source: 'session-log',
});

// $/Mtok rates chosen so 1M tokens of each class sum to a round number.
const PRICES = { m1: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } };

describe('pricing math', () => {
  it('ships a price for every model in the default harness configs — Cost is never incomplete out of the box', async () => {
    const { defaultConfig } = await import('../src/config.js');
    for (const harness of Object.values(defaultConfig().harnesses)) {
      for (const model of new Set([harness.defaultModel, ...harness.models])) {
        const cost = costOfUsages([usageOf({ [model]: mu(1000) })], resolvePrices({}));
        expect(cost?.incomplete, `no DEFAULT_PRICES entry for ${model}`).toBe(false);
      }
    }
  });

  it('prices all four token classes per model', () => {
    const cost = costOfUsages([usageOf({ m1: mu(1_000_000) })], PRICES);
    expect(cost).toEqual({ totalUsd: 10, byModel: { m1: 10 }, incomplete: false });
  });

  it('yields no cost for an unpriced model — never a fake zero', () => {
    const cost = costOfUsages([usageOf({ mystery: mu(1_000_000) })], PRICES);
    expect(cost).toEqual({ totalUsd: null, byModel: { mystery: null }, incomplete: true });
  });

  it('flags aggregates containing an unpriced model incomplete, keeping the partial sum', () => {
    const cost = costOfUsages([usageOf({ m1: mu(1_000_000), mystery: mu(5) })], PRICES);
    expect(cost).toEqual({ totalUsd: 10, byModel: { m1: 10, mystery: null }, incomplete: true });
  });

  it('sums usage across runs, retries included (task-level cost)', () => {
    const cost = costOfUsages(
      [usageOf({ m1: mu(500_000) }), null, usageOf({ m1: mu(500_000) })],
      PRICES,
    );
    expect(cost).toEqual({ totalUsd: 10, byModel: { m1: 10 }, incomplete: false });
  });

  it('returns null when there is no usage at all', () => {
    expect(costOfUsages([], PRICES)).toBeNull();
    expect(costOfUsages([null, null], PRICES)).toBeNull();
  });

  it('flags aggregate-only usage (tokens without a per-model split) incomplete', () => {
    const acpOnly: RunUsage = {
      models: {},
      totals: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12 },
      toolCalls: {},
      source: 'acp',
    };
    expect(costOfUsages([acpOnly], PRICES)).toEqual({ totalUsd: null, byModel: {}, incomplete: true });
  });

  it('matches date-suffixed model ids to their base price entry', () => {
    const cost = costOfUsages(
      [usageOf({ 'claude-haiku-4-5-20251001': mu(0) })],
      resolvePrices({}),
    );
    expect(cost?.incomplete).toBe(false);
  });

  it('ships defaults for the models the supported harnesses use; overrides win', () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5', 'gpt-5.2-codex']) {
      expect(DEFAULT_PRICES[model], model).toBeDefined();
    }
    const resolved = resolvePrices({ 'claude-sonnet-5': { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 } });
    expect(resolved['claude-sonnet-5']!.input).toBe(99);
    expect(resolved['claude-opus-4-8']).toEqual(DEFAULT_PRICES['claude-opus-4-8']);
  });
});

describe('cost surfaces (API)', () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.close();
  });

  /** Boot a server whose stub harness "logs" the given per-model token usage. */
  const serverWithLoggedUsage = async (
    workDirModels: Record<string, Record<string, number>>, // workDir -> model -> input_tokens
    prices: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>,
  ) => {
    const logRoot = mkdtempSync(join(tmpdir(), 'agentdeck-cost-logs-'));
    const overrides = stubHarness() as DeepPartial<AppConfig> & {
      harnesses: { claude: Record<string, unknown> };
      prices?: unknown;
    };
    overrides.harnesses.claude.sessionLogDir = logRoot;
    overrides.harnesses.claude.env = { STUB_SESSION_ID: 'fixed-session' };
    overrides.prices = prices;

    for (const [workDir, models] of Object.entries(workDirModels)) {
      const slug = workDir.replace(/[^a-zA-Z0-9]/g, '-');
      mkdirSync(join(logRoot, slug), { recursive: true });
      const lines = Object.entries(models).map(([model, inputTokens], i) =>
        JSON.stringify({
          type: 'assistant',
          message: {
            id: `msg-${model}-${i}`,
            model,
            usage: { input_tokens: inputTokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }),
      );
      writeFileSync(join(logRoot, slug, 'fixed-session.jsonl'), lines.join('\n'));
    }
    return startServer(overrides);
  };

  const runToDone = async (workingDir: string, expectState = 'awaiting-review') => {
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({}), workingDir });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === expectState);
    return { taskId: created.body.id as number, runId: started.body.id as number };
  };

  const flatPrice = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });

  it('run detail carries cost with the per-model split; config price changes apply retroactively', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'agentdeck-cost-work-'));
    server = await serverWithLoggedUsage(
      { [workDir]: { modelA: 1_000_000 } },
      { modelA: flatPrice(2) },
    );
    const { runId } = await runToDone(workDir);

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.cost).toEqual({ totalUsd: 2, byModel: { modelA: 2 }, incomplete: false });

    // Cost is derived on read: repricing rewrites history.
    await server.api('PATCH', '/api/config', { prices: { modelA: flatPrice(4) } });
    const repriced = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(repriced.cost.totalUsd).toBe(4);
  });

  it('task usage endpoint sums cost over ALL runs, failed attempts included', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'agentdeck-cost-work-'));
    server = await serverWithLoggedUsage(
      { [workDir]: { modelA: 1_000_000 } },
      { modelA: flatPrice(2) },
    );
    const { taskId } = await runToDone(workDir);
    await server.api('POST', `/api/tasks/${taskId}/reject`);
    await server.api('POST', `/api/tasks/${taskId}/requeue`);
    await server.api('POST', `/api/tasks/${taskId}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'awaiting-review');

    const agg = (await server.api('GET', `/api/tasks/${taskId}/usage`)).body;
    expect(agg.runCount).toBe(2);
    expect(agg.cost).toEqual({ totalUsd: 4, byModel: { modelA: 4 }, incomplete: false });
  });

  it('task list carries cost and sorts by it server-side', async () => {
    const dirCheap = mkdtempSync(join(tmpdir(), 'agentdeck-cost-cheap-'));
    const dirDear = mkdtempSync(join(tmpdir(), 'agentdeck-cost-dear-'));
    const dirNone = mkdtempSync(join(tmpdir(), 'agentdeck-cost-none-'));
    server = await serverWithLoggedUsage(
      { [dirCheap]: { modelA: 1_000_000 }, [dirDear]: { modelB: 1_000_000 } },
      { modelA: flatPrice(1), modelB: flatPrice(3) },
    );
    const cheap = await runToDone(dirCheap);
    const dear = await runToDone(dirDear);
    const none = await server.api('POST', '/api/tasks', { prompt: 'no runs', state: 'draft', workingDir: dirNone });

    const desc = (await server.api('GET', '/api/tasks?sortBy=cost&order=desc')).body.tasks;
    expect(desc.map((t: any) => t.id)).toEqual([dear.taskId, cheap.taskId, none.body.id]);
    expect(desc[0].cost.totalUsd).toBe(3);
    expect(desc[1].cost.totalUsd).toBe(1);
    expect(desc[2].cost).toBeNull();

    const asc = (await server.api('GET', '/api/tasks?sortBy=cost&order=asc')).body.tasks;
    expect(asc.map((t: any) => t.id)).toEqual([none.body.id, cheap.taskId, dear.taskId]);
  });

  it('backfills a missing per-model split at boot, preserving ACP totals (log-flush race healing)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'agentdeck-cost-work-'));
    const logRoot = mkdtempSync(join(tmpdir(), 'agentdeck-cost-logs-'));
    const overrides = stubHarness() as DeepPartial<AppConfig> & {
      harnesses: { claude: Record<string, unknown> };
      prices?: unknown;
    };
    overrides.harnesses.claude.sessionLogDir = logRoot;
    overrides.harnesses.claude.env = { STUB_SESSION_ID: 'fixed-session' };
    overrides.prices = { modelA: flatPrice(2) };

    // No log file yet: the run stores ACP totals with an empty model split.
    server = await startServer(overrides);
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }),
      workingDir: workDir,
    });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review');
    const before = (await server.api('GET', `/api/runs/${started.body.id}`)).body;
    expect(before.usage.models).toEqual({});
    expect(before.cost).toEqual({ totalUsd: null, byModel: {}, incomplete: true });

    // The harness's log turns up late — after the run finished.
    const slug = workDir.replace(/[^a-zA-Z0-9]/g, '-');
    mkdirSync(join(logRoot, slug), { recursive: true });
    writeFileSync(
      join(logRoot, slug, 'fixed-session.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', model: 'modelA', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
      }),
    );

    const dataDir = server.dataDir;
    await server.app.close();
    server = await startServer(overrides, { dataDir });

    const healed = (await server.api('GET', `/api/runs/${started.body.id}`)).body;
    expect(healed.usage.models.modelA.inputTokens).toBe(1_000_000);
    expect(healed.usage.totals.totalTokens).toBe(3); // ACP totals preserved
    expect(healed.usage.source).toBe('combined');
    expect(healed.cost).toEqual({ totalUsd: 2, byModel: { modelA: 2 }, incomplete: false });
  });

  it('stats carry period cost, per-model cost, and the incomplete flag for unpriced models', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'agentdeck-cost-work-'));
    server = await serverWithLoggedUsage(
      { [workDir]: { modelA: 1_000_000, mystery: 5 } },
      { modelA: flatPrice(2) },
    );
    await runToDone(workDir);

    const stats = (await server.api('GET', `/api/stats?from=0&to=${Date.now() + 1000}`)).body;
    expect(stats.cost).toEqual({ totalUsd: 2, byModel: { modelA: 2, mystery: null }, incomplete: true });
  });
});
