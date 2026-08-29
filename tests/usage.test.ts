import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, writeCopilotUsageDb, type TestServer } from './helpers.js';
import type { DeepPartial, AppConfig } from '../src/config.js';
import { collectUsage, totalTokensOf } from '../src/execution/usage.js';
import type { ModelUsage, RunUsage } from '../src/execution/usage.js';
import type { PersistedAttemptEvent } from '../src/domain/attempts.js';
import { currentTurnEvents } from '../src/domain/replay-quarantine.js';

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

  it('re-reads an existing session log until the per-model lines merge', async () => {
    const { collectUsageWithRetry } = await import('../src/execution/usage.js');
    const logRoot = mkdtempSync(join(tmpdir(), 'harmonic-race-logs-'));
    const cwd = mkdtempSync(join(tmpdir(), 'harmonic-race-work-'));
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const file = join(logRoot, slug, 'race-session.jsonl');
    mkdirSync(join(logRoot, slug), { recursive: true });
    // The file exists (session started) but the usage lines merge late.
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

describe('collectUsage rolls Subagent models + per-agent breakdown into the persisted Usage', () => {
  const assistant = (model: string, u: Record<string, number>, id = model) =>
    JSON.stringify({ type: 'assistant', message: { id, model, usage: u } });

  it('the settle-time collector shows a Subagent model (not just the root) and folds a per-agent breakdown', () => {
    const logRoot = mkdtempSync(join(tmpdir(), 'harmonic-agents-logs-'));
    const cwd = mkdtempSync(join(tmpdir(), 'harmonic-agents-work-'));
    const S = 'agents-session';
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    mkdirSync(join(logRoot, slug), { recursive: true });
    const subs = join(logRoot, slug, S, 'subagents');
    mkdirSync(subs, { recursive: true });

    // Root runs Opus; a spawned Subagent runs Sonnet — the model the old
    // parent-only collector dropped ("shows no Sonnet").
    writeFileSync(join(logRoot, slug, `${S}.jsonl`), assistant('claude-opus-4-8', { input_tokens: 100, output_tokens: 10 }));
    writeFileSync(join(subs, 'agent-a1.jsonl'), assistant('claude-sonnet-5', { input_tokens: 40, output_tokens: 4 }));
    writeFileSync(join(subs, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'code-reviewer', toolUseId: 'toolu_1', spawnDepth: 1 }));

    // No ACP prompt result → the per-model split (and totals) come from the log.
    const usage = collectUsage({
      harnessId: 'claude',
      harness: { command: 'x', args: [], env: {}, models: [], defaultModel: 'x', sessionLogDir: logRoot },
      cwd,
      sessionId: S,
      events: [],
    })!;

    // The Subagent's Sonnet now appears in the per-model breakdown.
    expect(usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(usage.models['claude-sonnet-5']).toMatchObject({ inputTokens: 40, outputTokens: 4 });
    // Totals roll the whole tree up (Subagent tokens count).
    expect(usage.totals).toMatchObject({ inputTokens: 140, outputTokens: 14 });
    // Per-agent breakdown: the root bucket and the Subagent's agentType bucket.
    expect(usage.agents?.root).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(usage.agents?.['code-reviewer']).toMatchObject({ inputTokens: 40, outputTokens: 4 });
  });

  it('uses Codex child rollout usage instead of root-only prompt-result usage', () => {
    const logRoot = mkdtempSync(join(tmpdir(), 'harmonic-codex-agents-logs-'));
    const day = join(logRoot, '2026', '08', '24');
    mkdirSync(day, { recursive: true });
    const turn = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model } });
    const tokenCount = (input: number, output: number) =>
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } } },
      });
    writeFileSync(join(day, 'rollout-x-root.jsonl'), [turn('gpt-5.6-sol'), tokenCount(100, 10)].join('\n'));
    writeFileSync(
      join(day, 'rollout-x-child.jsonl'),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'child',
            parent_thread_id: 'root',
            source: { subagent: { thread_spawn: { agent_path: '/root/code-review' } } },
          },
        }),
        JSON.stringify({ type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } }),
        turn('gpt-5.6-mini'),
        tokenCount(40, 4),
      ].join('\n'),
    );

    const usage = collectUsage({
      harnessId: 'codex',
      harness: { command: 'x', args: [], env: {}, models: [], defaultModel: 'x', sessionLogDir: logRoot },
      cwd: '/w',
      sessionId: 'root',
      promptResult: { usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
      events: [],
    })!;

    expect(usage.models).toMatchObject({
      'gpt-5.6-sol': { inputTokens: 100, outputTokens: 10 },
      'gpt-5.6-mini': { inputTokens: 40, outputTokens: 4 },
    });
    expect(usage.totals).toMatchObject({ inputTokens: 140, outputTokens: 14 });
    expect(usage.agents?.['/root/code-review']).toMatchObject({ inputTokens: 40, outputTokens: 4 });
  });
});

describe('replay quarantine (issue #144)', () => {
  const input = (logRoot: string, cwd: string, events: PersistedAttemptEvent[]): Parameters<typeof collectUsage>[0] => ({
    harnessId: 'claude',
    harness: { command: 'x', args: [], env: {}, models: [], defaultModel: 'x', sessionLogDir: logRoot },
    cwd,
    sessionId: 'x',
    promptResult: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
    events,
  });

  const toolCall = (over: Partial<PersistedAttemptEvent> & { toolCallId: string; title: string }): PersistedAttemptEvent => ({
    id: 1,
    attemptId: 1,
    seq: 1,
    ts: 1,
    type: 'session_update',
    payload: { sessionUpdate: 'tool_call', toolCallId: over.toolCallId, title: over.title, kind: 'edit' },
    ...over,
  });

  it('replayed tool_call events contribute zero to collectUsage(...).toolCalls', () => {
    const logRoot = mkdtempSync(join(tmpdir(), 'harmonic-replay-logs-'));
    const cwd = mkdtempSync(join(tmpdir(), 'harmonic-replay-work-'));
    const events: PersistedAttemptEvent[] = [
      toolCall({ toolCallId: 't1', title: 'Edit', replay: true }),
      toolCall({ toolCallId: 't2', title: 'Write', replay: true }),
      toolCall({ toolCallId: 't3', title: 'Read', replay: true }),
    ];

    const usage = collectUsage(input(logRoot, cwd, events));
    expect(usage?.toolCalls).toEqual({});
  });

  it('a mix counts only the current-turn tool_call — a replay of prior history counts as zero current-turn usage (AC5)', () => {
    const logRoot = mkdtempSync(join(tmpdir(), 'harmonic-replay-logs-'));
    const cwd = mkdtempSync(join(tmpdir(), 'harmonic-replay-work-'));
    const events: PersistedAttemptEvent[] = [
      toolCall({ toolCallId: 't1', title: 'Edit', replay: true }),
      toolCall({ toolCallId: 't2', title: 'Write', replay: true }),
      toolCall({ toolCallId: 't3', title: 'Bash', replay: false }),
    ];

    const usage = collectUsage(input(logRoot, cwd, events));
    expect(usage?.toolCalls).toEqual({ Bash: 1 });
  });

  it('groups shell commands under Bash instead of their command text (issue #318)', async () => {
    const { tallyToolCalls } = await import('../src/execution/usage.js');
    const events: PersistedAttemptEvent[] = [
      toolCall({
        toolCallId: 't1',
        title: 'while ps -p 92228 >/dev/null; do sleep 5; done',
        payload: {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'while ps -p 92228 >/dev/null; do sleep 5; done',
          kind: 'execute',
        },
      }),
    ];

    expect(tallyToolCalls(events, () => null)).toEqual({ Bash: 1 });
  });

  it('buckets read/search/fetch kinds by tool, not their per-call title', async () => {
    const { tallyToolCalls } = await import('../src/execution/usage.js');
    const tc = (id: string, kind: string, title: string): PersistedAttemptEvent => ({
      id: 1,
      attemptId: 1,
      seq: 1,
      ts: 1,
      type: 'session_update',
      payload: { sessionUpdate: 'tool_call', toolCallId: id, title, kind },
    });
    const events: PersistedAttemptEvent[] = [
      tc('t1', 'read', "Read file '/a/one.ts'"),
      tc('t2', 'read', "Read file '/b/two.ts'"),
      tc('t3', 'search', "Search for 'foo' in App.tsx"),
      tc('t4', 'fetch', 'https://example.com/x'),
      tc('t5', 'fetch', 'https://example.com/y'),
    ];

    expect(tallyToolCalls(events, () => null)).toEqual({ Read: 2, Grep: 1, WebFetch: 2 });
  });

  it('currentTurnEvents returns only the non-replay events', () => {
    const events: PersistedAttemptEvent[] = [
      toolCall({ toolCallId: 't1', title: 'Edit', replay: true }),
      toolCall({ toolCallId: 't2', title: 'Bash', replay: false }),
      toolCall({ toolCallId: 't3', title: 'Read', replay: true }),
    ];

    expect(currentTurnEvents(events)).toEqual([events[1]]);
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

describe('per-tool output-token attribution (issue #195)', () => {
  it('splits each turn across parallel calls, collapses repeated tools, and sends no-tool output to reasoning', async () => {
    const { attributeTurnTokens } = await import('../src/execution/usage.js');

    const attributed = attributeTurnTokens([
      { model: 'claude-sonnet-5', usage: { inputTokens: 0, outputTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0 }, tools: ['Read', 'Write', 'Read'] },
      { model: 'claude-sonnet-5', usage: { inputTokens: 0, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, tools: [] },
    ]);

    // The final parallel call receives the integer remainder, so every turn
    // reconciles exactly even when its output cannot divide evenly by calls.
    expect(attributed).toEqual({
      toolTokens: {
        Read: { outputTokens: 8, cost: 0.00010999999999999999 },
        Write: { outputTokens: 3, cost: 0.000055 },
      },
      reasoning: { outputTokens: 5, cost: 0.000075 },
    });
  });

  it('leaves output cost absent for an unpriced model rather than inventing a zero', async () => {
    const { attributeTurnTokens } = await import('../src/execution/usage.js');

    expect(attributeTurnTokens([{ model: 'unknown', usage: { inputTokens: 0, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }, tools: ['Read'] }])).toEqual({
      toolTokens: { Read: { outputTokens: 3 } },
    });
  });
});

describe('per-tool output attribution', () => {
  const assistantTurn = (model: string, outputTokens: number, toolNames: string[]) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        id: `${model}-${outputTokens}-${toolNames.join('-') || 'reasoning'}`,
        model,
        usage: { input_tokens: 0, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: toolNames.map((name, i) => ({ type: 'tool_use', id: `toolu_${outputTokens}_${i}`, name })),
      },
    });

  it('splits one turn by tool-call count, collapses repeated tools, and routes no-tool turns to reasoning', async () => {
    const logRoot = mkdtempSync(join(tmpdir(), 'harmonic-tool-logs-'));
    const cwd = mkdtempSync(join(tmpdir(), 'harmonic-tool-work-'));
    const sessionId = 'tool-session';
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    mkdirSync(join(logRoot, slug), { recursive: true });
    writeFileSync(
      join(logRoot, slug, `${sessionId}.jsonl`),
      [
        assistantTurn('claude-sonnet-5', 5, ['Read', 'Read', 'Bash']),
        assistantTurn('claude-sonnet-5', 4, []),
        assistantTurn('claude-sonnet-5', 5, ['Edit', 'Write']),
      ].join('\n'),
    );

    const usage = collectUsage({
      harnessId: 'claude',
      harness: { command: 'x', args: [], env: {}, models: [], defaultModel: 'x', sessionLogDir: logRoot },
      cwd,
      sessionId,
      events: [],
    })!;

    expect(usage.toolTokens).toEqual({
      Read: { outputTokens: 2, cost: 0.000049999999999999996 },
      Bash: { outputTokens: 3, cost: 0.000024999999999999998 },
      Edit: { outputTokens: 2, cost: 0.0000375 },
      Write: { outputTokens: 3, cost: 0.0000375 },
    });
    expect(usage.reasoning).toEqual({ outputTokens: 4, cost: 0.00006 });
  });

  it('mergeUsage sums tool attribution across runs without inventing missing buckets', async () => {
    const { mergeUsage } = await import('../src/execution/usage.js');
    const attributed = (over: Partial<RunUsage>): RunUsage => ({
      models: {},
      totals: null,
      toolCalls: {},
      source: 'session-log',
      ...over,
    });

    const merged = mergeUsage([
      attributed({ toolTokens: { Read: { outputTokens: 2 }, Bash: { outputTokens: 3 } }, reasoning: { outputTokens: 4 } }),
      attributed({ toolTokens: { Read: { outputTokens: 5 }, Edit: { outputTokens: 1 } } }),
    ])!;

    expect(merged.toolTokens).toEqual({
      Read: { outputTokens: 7 },
      Bash: { outputTokens: 3 },
      Edit: { outputTokens: 1 },
    });
    expect(merged.reasoning).toEqual({ outputTokens: 4 });
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

  // The tests below that boot a plain `stubHarness()` share one server (their
  // assertions are all per-run/per-task, so accumulated DB state is inert) —
  // each boot is a full Fastify + libsql + migration cycle. Tests with
  // per-harness overrides, and the stats test (which asserts on whole-DB
  // totals), keep their own boots.
  let shared: TestServer | undefined;
  const sharedServer = async () => (shared ??= await startServer(stubHarness()));

  afterEach(async () => {
    if (server && server !== shared) await server.close();
  });
  afterAll(async () => {
    await shared?.close();
  });

  const runTask = async (input: object): Promise<{ taskId: number; runId: number }> => {
    const created = await server.api('POST', '/api/tasks', input);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${created.body.id}`);
      return body.state === 'done' || body.state === 'failed';
    });
    return { taskId: created.body.id, runId: started.body.id };
  };

  it('collects aggregate usage from the ACP prompt result and tallies tool calls from events', async () => {
    server = await sharedServer();
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

    const run = (await server.api('GET', `/api/attempts/${runId}`)).body;
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

    const run = (await server.api('GET', `/api/attempts/${runId}`)).body;
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

    const run = (await server.api('GET', `/api/attempts/${runId}`)).body;
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

    const run = (await server.api('GET', `/api/attempts/${runId}`)).body;
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
    const events = (await server.api('GET', `/api/attempts/${runId}/events`)).body.events;
    expect(events.find((e: any) => e.payload?.event === 'model_mismatch')).toBeUndefined();

    // …but a real pin the plan silently ignored (auto-only plans accept
    // set_model and route anyway, spike Q2) IS surfaced on the run.
    const pinned = await runTask({
      harness: 'copilot',
      model: 'gpt-5.4',
      workingDir: workDir,
      prompt: JSON.stringify({}),
    });
    const pinnedEvents = (await server.api('GET', `/api/attempts/${pinned.runId}/events`)).body.events;
    expect(pinnedEvents.find((e: any) => e.payload?.event === 'model_mismatch')?.payload).toMatchObject({
      expected: 'gpt-5.4',
      observed: expect.arrayContaining(['gpt-5-mini', 'claude-haiku-4.5']),
    });
  });

  it('reports usage as unavailable — not zero — when neither source exists', async () => {
    server = await sharedServer();
    const { runId } = await runTask({ prompt: JSON.stringify({}) });
    const run = (await server.api('GET', `/api/attempts/${runId}`)).body;
    expect(run.usage).toBeNull();
  });

  it('aggregates usage per task across runs, including retries', async () => {
    server = await sharedServer();
    const usageScenario = JSON.stringify({
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      exit: 'clean',
    });
    const { taskId } = await runTask({ prompt: usageScenario });
    // A second Run on the same ticket with an identical prompt replays the same
    // usage scenario (the ticket is re-queued directly: an operator Reject would
    // bake guidance into the prompt, which the stub parses as its scenario).
    await server.app.ctx.tasks.setState(taskId, 'ready');
    await server.api('POST', `/api/tasks/${taskId}/run`);
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      if (body.state !== 'done') return undefined;
      return (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts.length === 2 ? true : undefined;
    });

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
        updates: [
          {
            sessionUpdate: 'tool_call',
            toolCallId: 't1',
            title: 'while ps -p 92228 >/dev/null; do sleep 5; done',
            kind: 'execute',
            status: 'pending',
          },
        ],
        usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
      }),
    });

    const all = await server.api('GET', `/api/stats?from=0&to=${Date.now() + 1000}`);
    expect(all.status).toBe(200);
    expect(all.body.totals.inputTokens).toBe(5);
    expect(all.body.toolCalls).toEqual({ Bash: 1 });
    expect(all.body.runCount).toBe(1);
    // Per-day chart series: one bucket at today's local midnight, carrying
    // cost, input+output tokens (cache excluded), and run count (issue #194).
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    expect(all.body.series).toHaveLength(1);
    expect(all.body.series[0].day).toBe(midnight.getTime());
    expect(all.body.series[0].tokens).toBe(12); // 5 input + 7 output
    expect(all.body.series[0].runs).toBe(1);
    expect(all.body.series[0]).toHaveProperty('totalUsd');
    expect(all.body.series[0]).toHaveProperty('incomplete');

    const empty = await server.api('GET', `/api/stats?from=${Date.now() + 60_000}&to=${Date.now() + 120_000}`);
    expect(empty.body.runCount).toBe(0);
    expect(empty.body.totals).toBeNull();
    expect(empty.body.series).toEqual([]);
  });
});

// The token count the live spend Guardrail (#128) reads each poll — pinned at
// the usage seam so its telemetry-null-vs-zero distinction can't regress.
describe('totalTokensOf (issue #128 spend-guard token reading)', () => {
  const mu = (n: number): ModelUsage => ({
    inputTokens: n,
    outputTokens: n,
    cacheReadTokens: n,
    cacheWriteTokens: n,
  });
  const usage = (over: Partial<RunUsage>): RunUsage => ({
    models: {},
    totals: null,
    toolCalls: {},
    source: 'session-log',
    ...over,
  });

  it('prefers the reported aggregate totalTokens when present', () => {
    const u = usage({
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 4242 },
    });
    expect(totalTokensOf(u)).toBe(4242);
  });

  it('sums the four token classes across the per-model split when no aggregate is reported', () => {
    // two models × (10+10+10+10) = 80
    const u = usage({ models: { a: mu(10), b: mu(10) } });
    expect(totalTokensOf(u)).toBe(80);
  });

  it('is null when there is no telemetry at all — distinct from a real zero reading', () => {
    expect(totalTokensOf(usage({}))).toBeNull();
    // A genuine all-zero model IS measurable (0), never null.
    expect(totalTokensOf(usage({ models: { a: mu(0) } }))).toBe(0);
  });
});
