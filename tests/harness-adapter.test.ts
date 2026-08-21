import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterFor } from '../src/execution/harness/adapter.js';
import { writeCopilotUsageDb } from './helpers.js';

/** Every adapter call in these tests runs "in" this directory. */
const spawnInput = (model: string, extra: { cwd?: string; sessionLogDir?: string } = {}) => ({
  model,
  cwd: extra.cwd ?? '/w',
  sessionLogDir: extra.sessionLogDir,
});

describe('harness adapters', () => {
  it('claude spawn tweaks pin the model and strip the nested-session guard vars', () => {
    const env = adapterFor('claude').spawnEnv(spawnInput('claude-opus-4-8'));
    expect(env.ANTHROPIC_MODEL).toBe('claude-opus-4-8');
    // Present-but-undefined so they override anything inherited from process.env.
    expect(env).toHaveProperty('CLAUDECODE', undefined);
    expect(env).toHaveProperty('CLAUDE_CODE_ENTRYPOINT', undefined);
  });

  it('unknown harnesses have no Usage Collector', () => {
    expect(adapterFor('mystery').usage).toBeNull();
  });

  it('codex spawn tweaks pin the model via CODEX_CONFIG, splitting the model[effort] grammar', () => {
    // Spike (issue 22): CODEX_CONFIG is a JSON object merged into the
    // session config; modelId grammar is `<model>[<effort>]`.
    expect(JSON.parse(adapterFor('codex').spawnEnv(spawnInput('gpt-5.4-mini[low]')).CODEX_CONFIG!)).toEqual({
      approval_policy: 'on-request',
      model: 'gpt-5.4-mini',
      model_reasoning_effort: 'low',
    });
    expect(JSON.parse(adapterFor('codex').spawnEnv(spawnInput('gpt-5.6-sol')).CODEX_CONFIG!)).toEqual({
      approval_policy: 'on-request',
      model: 'gpt-5.6-sol',
    });
  });

  it('only copilot pins via ACP session/set_model — sent for every run, auto included', () => {
    // Spike (issue 25): an unpinned Copilot session inherits the
    // operator's persisted settings.json model, so the pin must be sent
    // even when the Task's model is 'auto'. Claude and Codex pin at
    // spawn time instead.
    expect(adapterFor('copilot').sessionModelId?.('claude-haiku-4.5')).toBe('claude-haiku-4.5');
    expect(adapterFor('copilot').sessionModelId?.('auto')).toBe('auto');
    expect(adapterFor('claude').sessionModelId).toBeUndefined();
    expect(adapterFor('codex').sessionModelId).toBeUndefined();
  });

  it('copilot spawn tweaks disable auto-update and never pin via --model or OTel', () => {
    const env = adapterFor('copilot').spawnEnv(spawnInput('claude-haiku-4.5'));
    // The CLI updated itself mid-spike; runs must be reproducible.
    expect(env.COPILOT_AUTO_UPDATE).toBe('false');
    // Spike capture 13: --model/COPILOT_MODEL falsify the session's
    // reported model without changing it. The pin goes via set_model only.
    expect(env.COPILOT_MODEL).toBeUndefined();
    // OTel is gone (ADR 0009): Usage now comes from session-store.db.
    expect(env).not.toHaveProperty('COPILOT_OTEL_FILE_EXPORTER_PATH');
  });

  it.each(['claude', 'codex', 'copilot'])(
    '%s registers the MCP server over ACP with the Run Key bearer header',
    (harness) => {
      // The env vars alone never registered the server; every harness must
      // return the ACP session/new entry so agents get the `harmonic` tools.
      expect(adapterFor(harness).mcpServers({ url: 'http://127.0.0.1:1/mcp', token: 'rk' })).toEqual([
        {
          name: 'harmonic',
          type: 'http',
          url: 'http://127.0.0.1:1/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer rk' }],
        },
      ]);
    },
  );

  it("copilot's Usage Collector reads the native store and needs a sessionId to attribute rows", () => {
    const usage = adapterFor('copilot').usage!;
    expect(usage.sessionLogFile({ sessionLogDir: '/copilot', cwd: '/w', sessionId: 's1' })).toBe(
      '/copilot/session-store.db',
    );
    // No sessionId (spawn died before session/new): nothing to attribute.
    expect(usage.sessionLogFile({ sessionLogDir: '/copilot', cwd: '/w', sessionId: null })).toBeNull();
  });

  it("copilot's Usage Collector aggregates session-store.db rows by model, with the cache split and AI Units", () => {
    // Row shapes from the real session-store.db: input_tokens is TOTAL
    // input, cache columns omit-when-zero, total_nano_aiu → AI Units.
    const S = '574df71c-25b3-4829-b01a-4dc8d50f47e8';
    const dir = mkdtempSync(join(tmpdir(), 'copilot-db-'));
    const file = join(dir, 'session-store.db');
    writeCopilotUsageDb(file, [
      { session_id: S, model: 'gpt-5-mini', input_tokens: 35068, output_tokens: 4539, total_nano_aiu: 1784500000 },
      {
        session_id: S,
        model: 'gpt-5-mini',
        input_tokens: 39727,
        output_tokens: 783,
        cache_read_tokens: 39552,
        total_nano_aiu: 259855000,
      },
      {
        session_id: S,
        model: 'claude-haiku-4.5',
        input_tokens: 48503,
        output_tokens: 145,
        cache_write_tokens: 48494,
        total_nano_aiu: 6135150000,
      },
      // Another session sharing the store: filtered out by session_id.
      { session_id: 'other-session', model: 'gpt-5-mini', input_tokens: 999999, output_tokens: 999999, total_nano_aiu: 9e9 },
    ]);

    // ModelUsage.inputTokens is uncached-only: total minus both cache figures.
    expect(adapterFor('copilot').usage!.modelsFromSessionLog(file, S)).toEqual({
      'gpt-5-mini': {
        inputTokens: 35068 + (39727 - 39552),
        outputTokens: 4539 + 783,
        cacheReadTokens: 39552,
        cacheWriteTokens: 0,
        aiUnits: (1784500000 + 259855000) / 1e9,
      },
      'claude-haiku-4.5': {
        inputTokens: 48503 - 48494,
        outputTokens: 145,
        cacheReadTokens: 0,
        cacheWriteTokens: 48494,
        aiUnits: 6135150000 / 1e9,
      },
    });
    expect(adapterFor('copilot').usage!.modelsFromSessionLog(join(dir, 'missing.db'), S)).toEqual({});
    // No sessionId to filter on: nothing is attributable, never guess.
    expect(adapterFor('copilot').usage!.modelsFromSessionLog(file, null)).toEqual({});
  });

  it("copilot's parse() builds a Subagent tree from the store + events.jsonl and rolls Subagent tokens up", () => {
    const S = 'parse-session';
    const home = mkdtempSync(join(tmpdir(), 'copilot-home-'));
    writeCopilotUsageDb(join(home, 'session-store.db'), [
      { session_id: S, model: 'gpt-5-mini', input_tokens: 1000, output_tokens: 100, total_nano_aiu: 500000000 },
      { session_id: S, model: 'gpt-5-mini', input_tokens: 2000, output_tokens: 200, cache_read_tokens: 1500, total_nano_aiu: 100000000 },
      // A Subagent's rows, joined to its spawning tool call.
      {
        session_id: S,
        parent_tool_call_id: 'tool_sub',
        model: 'claude-haiku-4.5',
        input_tokens: 500,
        output_tokens: 50,
        total_nano_aiu: 300000000,
      },
    ]);
    const eventsDir = join(home, 'session-state', S);
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(
      join(eventsDir, 'events.jsonl'),
      [
        JSON.stringify({ type: 'subagent.started', data: { toolCallId: 'tool_sub', agentName: 'rubber-duck' } }),
        JSON.stringify({ type: 'subagent.completed', data: { toolCallId: 'tool_sub', agentName: 'rubber-duck', model: 'claude-haiku-4.5' } }),
        // Started but no tokens yet: still a live (active) node.
        JSON.stringify({ type: 'subagent.started', data: { toolCallId: 'tool_pending', agentName: 'laravel-specialist' } }),
        'not json',
      ].join('\n'),
    );

    const parsed = adapterFor('copilot').usage!.parse!({ sessionLogDir: home, cwd: '/w', sessionId: S })!;

    // Flat Usage rolls up the whole tree — Subagent tokens count (the fix).
    expect(parsed.usage.models['claude-haiku-4.5']).toMatchObject({ inputTokens: 500, outputTokens: 50, aiUnits: 0.3 });
    expect(parsed.usage.models['gpt-5-mini']).toMatchObject({ inputTokens: 1000 + (2000 - 1500) });
    expect(parsed.usage.totals?.aiUnits).toBeCloseTo(0.9, 10);

    // Root node: own tokens only (no Subagent), latest request as context fill.
    expect(parsed.tree).toMatchObject({ id: S, depth: 0, model: 'gpt-5-mini', contextTokens: 2000 });
    expect(parsed.tree.usage).toMatchObject({ inputTokens: 1000 + (2000 - 1500), outputTokens: 300 });

    const children = parsed.tree.children;
    expect(children).toHaveLength(2);
    const sub = children.find((c) => c.id === 'tool_sub')!;
    expect(sub).toMatchObject({ name: 'rubber-duck', model: 'claude-haiku-4.5', status: 'inactive', depth: 1 });
    expect(sub.usage).toMatchObject({ inputTokens: 500, outputTokens: 50 });
    const pending = children.find((c) => c.id === 'tool_pending')!;
    expect(pending).toMatchObject({ name: 'laravel-specialist', status: 'active' });
    expect(pending.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });

    // No store and no events → no log yet, never a fake zero.
    expect(adapterFor('copilot').usage!.parse!({ cwd: '/w', sessionId: 'nope', sessionLogDir: home })).toBeNull();
  });

  it("codex's Usage Collector reads the per-model breakdown off the ACP prompt result", () => {
    // Verbatim shape from the spike's capture-codex-1-basic.jsonl.
    const result = {
      usage: { totalTokens: 16178, inputTokens: 6189, cachedReadTokens: 9984, outputTokens: 5, thoughtTokens: 0 },
      _meta: {
        quota: {
          token_count: { totalTokens: 16178, inputTokens: 6189, cachedInputTokens: 9984, outputTokens: 5, reasoningOutputTokens: 0 },
          model_usage: [
            {
              model: 'gpt-5.6-sol',
              token_count: { totalTokens: 16178, inputTokens: 6189, cachedInputTokens: 9984, outputTokens: 5, reasoningOutputTokens: 0 },
            },
          ],
        },
      },
    };
    expect(adapterFor('codex').usage!.modelsFromPromptResult!(result)).toEqual({
      'gpt-5.6-sol': { inputTokens: 6189, outputTokens: 5, cacheReadTokens: 9984, cacheWriteTokens: 0 },
    });
    // No _meta (failed turn, older adapter): no breakdown, never a fake zero.
    expect(adapterFor('codex').usage!.modelsFromPromptResult!({})).toEqual({});
  });

  it("codex's Usage Collector finds the rollout log by the sessionId embedded in its filename", () => {
    // Convention (spike): <root>/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<sessionId>.jsonl
    const root = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
    const day = join(root, '2026', '07', '14');
    mkdirSync(day, { recursive: true });
    const file = join(day, 'rollout-2026-07-14T17-40-50-019f6180-aca9-7f73-a912-b189b5850f53.jsonl');
    writeFileSync(file, '');

    const usage = adapterFor('codex').usage!;
    const input = { sessionLogDir: root, cwd: '/anywhere', sessionId: '019f6180-aca9-7f73-a912-b189b5850f53' };
    expect(usage.sessionLogFile(input)).toBe(file);
    expect(usage.sessionLogFile({ ...input, sessionId: 'not-there' })).toBeNull();
    expect(usage.sessionLogFile({ ...input, sessionId: null })).toBeNull();
  });

  it("codex's Usage Collector derives per-model usage from rollout turn_context × token_count deltas", () => {
    // First turn's numbers are verbatim from the spike's rollout excerpt
    // (capture 1); the second turn switches model, with capture 2's
    // numbers as the cumulative delta.
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 's1', cli_version: '0.144.4' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol', effort: 'low', summary: 'auto' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 16173, cached_input_tokens: 9984, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 16178 },
            last_token_usage: { input_tokens: 16173, cached_input_tokens: 9984, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 16178 },
            model_context_window: 258400,
          },
        },
      }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini', effort: 'low', summary: 'auto' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 31723, cached_input_tokens: 15488, output_tokens: 26, reasoning_output_tokens: 14, total_tokens: 31749 },
            last_token_usage: { input_tokens: 15550, cached_input_tokens: 5504, output_tokens: 21, reasoning_output_tokens: 14, total_tokens: 15571 },
            model_context_window: 258400,
          },
        },
      }),
      'log noise that is not JSON',
    ];
    const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-'));
    const file = join(dir, 'rollout-x-s1.jsonl');
    writeFileSync(file, lines.join('\n'));

    // Rollout `input_tokens` includes cached reads; ModelUsage.inputTokens
    // is uncached-only (the asymmetry noted in the spike's Q3).
    expect(adapterFor('codex').usage!.modelsFromSessionLog(file)).toEqual({
      'gpt-5.6-sol': { inputTokens: 6189, outputTokens: 5, cacheReadTokens: 9984, cacheWriteTokens: 0 },
      'gpt-5.4-mini': { inputTokens: 10046, outputTokens: 21, cacheReadTokens: 5504, cacheWriteTokens: 0 },
    });
    expect(adapterFor('codex').usage!.modelsFromSessionLog(join(dir, 'missing.jsonl'))).toEqual({});
  });

  it("codex's rollout parser never misattributes pre-context spend or goes negative on counter resets", () => {
    const tc = (input: number, cached: number, output: number) =>
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
        },
      });
    const turn = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model, effort: 'low' } });
    const lines = [
      tc(100, 40, 3), // before any turn_context: unattributable — dropped, but still baselines
      turn('m1'),
      tc(200, 80, 10), // m1 spends the delta: 60 uncached in, 40 cached, 7 out
      tc(50, 20, 5), // cumulative counter reset (session resume): re-baseline, attribute the entry itself
    ];
    const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-edge-'));
    const file = join(dir, 'rollout-x-s2.jsonl');
    writeFileSync(file, lines.join('\n'));

    expect(adapterFor('codex').usage!.modelsFromSessionLog(file)).toEqual({
      m1: { inputTokens: 90, outputTokens: 12, cacheReadTokens: 60, cacheWriteTokens: 0 },
    });
  });

  it("codex's parse() builds a single-node tree with context fill and the dominant model", () => {
    const lines = [
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol', effort: 'low' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 16173, cached_input_tokens: 9984, output_tokens: 5, total_tokens: 16178 },
            last_token_usage: { input_tokens: 16173, cached_input_tokens: 9984, output_tokens: 5, total_tokens: 16178 },
            model_context_window: 258400,
          },
        },
      }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini', effort: 'low' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 31723, cached_input_tokens: 15488, output_tokens: 26, total_tokens: 31749 },
            last_token_usage: { input_tokens: 15550, cached_input_tokens: 5504, output_tokens: 21, total_tokens: 15571 },
            model_context_window: 258400,
          },
        },
      }),
    ];
    const root = mkdtempSync(join(tmpdir(), 'codex-parse-'));
    const day = join(root, '2026', '07', '14');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-x-s1.jsonl'), lines.join('\n'));

    const parsed = adapterFor('codex').usage!.parse!({ sessionLogDir: root, cwd: '/w', sessionId: 's1' })!;
    // Flat Usage keeps the true per-model split.
    expect(parsed.usage.models).toEqual({
      'gpt-5.6-sol': { inputTokens: 6189, outputTokens: 5, cacheReadTokens: 9984, cacheWriteTokens: 0 },
      'gpt-5.4-mini': { inputTokens: 10046, outputTokens: 21, cacheReadTokens: 5504, cacheWriteTokens: 0 },
    });
    // Single node: no Subagents, dominant model, latest request as context fill.
    expect(parsed.tree).toMatchObject({ id: 's1', depth: 0, model: 'gpt-5.6-sol', contextTokens: 15550, children: [] });
    expect(parsed.tree.usage).toEqual({ inputTokens: 16235, outputTokens: 26, cacheReadTokens: 15488, cacheWriteTokens: 0 });
    // No rollout yet → no log coming, never a fake zero.
    expect(adapterFor('codex').usage!.parse!({ sessionLogDir: root, cwd: '/w', sessionId: 'missing' })).toBeNull();
  });

  it("claude's parse() builds a recursive Subagent tree and rolls every Subagent's tokens up", () => {
    const S = 'sess1';
    const home = mkdtempSync(join(tmpdir(), 'claude-home-'));
    const dir = join(home, '-w');
    const subs = join(dir, S, 'subagents');
    mkdirSync(join(subs, 'workflows', 'wf_x'), { recursive: true });

    const assistant = (model: string, u: Record<string, number>, id = model) =>
      JSON.stringify({ type: 'assistant', message: { id, model, usage: u } });
    const toolResult = (toolUseId: string) =>
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] } });

    // Parent: its own tokens + the tool_result that marks sub1 finished.
    writeFileSync(
      join(dir, `${S}.jsonl`),
      [
        assistant('claude-opus-4-8', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 }),
        toolResult('toolu_sub1'),
      ].join('\n'),
    );
    // Depth-1 Subagent (completed), and its own depth-2 child (still running).
    writeFileSync(join(subs, 'agent-a1.jsonl'), assistant('claude-opus-4-8', { input_tokens: 50, output_tokens: 5 }));
    writeFileSync(join(subs, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_sub1', spawnDepth: 1 }));
    writeFileSync(join(subs, 'agent-a2.jsonl'), assistant('claude-haiku-4-5', { input_tokens: 20, output_tokens: 2 }));
    writeFileSync(join(subs, 'agent-a2.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_sub2', parentAgentId: 'a1', spawnDepth: 2 }));
    // Workflow agent (no toolUseId) — hangs off the root, recursively found.
    writeFileSync(join(subs, 'workflows', 'wf_x', 'agent-a3.jsonl'), assistant('claude-opus-4-8', { input_tokens: 30, output_tokens: 3 }));
    writeFileSync(join(subs, 'workflows', 'wf_x', 'agent-a3.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));
    // A meta whose transcript hasn't been written yet (mid-run): no throw, zero usage.
    writeFileSync(join(subs, 'agent-a4.meta.json'), JSON.stringify({ agentType: 'code-reviewer', toolUseId: 'toolu_sub4', spawnDepth: 1 }));

    const parsed = adapterFor('claude').usage!.parse!({ sessionLogDir: home, cwd: '/w', sessionId: S })!;

    // Flat Usage rolls up the whole tree — every Subagent's tokens count (the undercount fix).
    expect(parsed.usage.models['claude-opus-4-8']).toEqual({ inputTokens: 100 + 50 + 30, outputTokens: 10 + 5 + 3, cacheReadTokens: 5, cacheWriteTokens: 2 });
    expect(parsed.usage.models['claude-haiku-4-5']).toEqual({ inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });

    // Root: own tokens only, latest message's input-side footprint as context fill.
    expect(parsed.tree).toMatchObject({ id: S, depth: 0, model: 'claude-opus-4-8', contextTokens: 107 });
    expect(parsed.tree.usage).toEqual({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2 });

    const byId = Object.fromEntries(parsed.tree.children.map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual(['a1', 'a3', 'a4']);
    expect(byId.a1).toMatchObject({ name: 'general-purpose', status: 'inactive', depth: 1 });
    expect(byId.a3).toMatchObject({ name: 'workflow-subagent', status: 'active' });
    expect(byId.a4).toMatchObject({ status: 'active' });
    expect(byId.a4!.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // Depth-2 child nests under its spawning Subagent via parentAgentId.
    expect(byId.a1!.children).toHaveLength(1);
    expect(byId.a1!.children[0]).toMatchObject({ id: 'a2', name: 'Explore', model: 'claude-haiku-4-5', status: 'active', depth: 2 });

    // No transcript yet → no log, never a fake zero.
    expect(adapterFor('claude').usage!.parse!({ sessionLogDir: home, cwd: '/w', sessionId: 'missing' })).toBeNull();
  });

  it("claude's Usage Collector locates the session log by the cwd-slug convention", () => {
    const usage = adapterFor('claude').usage!;
    expect(
      usage.sessionLogFile({ sessionLogDir: '/logs', cwd: '/tmp/my.work_dir', sessionId: 'abc-123' }),
    ).toBe('/logs/-tmp-my-work-dir/abc-123.jsonl');
    // Default log root when the operator has not configured one.
    expect(usage.sessionLogFile({ cwd: '/w', sessionId: 's1' })).toBe(
      join(homedir(), '.claude', 'projects', '-w', 's1.jsonl'),
    );
    expect(usage.sessionLogFile({ sessionLogDir: '/logs', cwd: '/w', sessionId: null })).toBeNull();
  });

  it('discovers Claude transcripts from the actual projects directory, without recreating the cwd slug', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-projects-'));
    const actualDir = join(root, 'claude-chose-this-name');
    mkdirSync(actualDir);
    const transcript = join(actualDir, 'abc-123.jsonl');
    writeFileSync(transcript, '[]');

    await expect(adapterFor('claude').usage!.resolveTranscriptPath!({ sessionLogDir: root, sessionId: 'abc-123' })).resolves.toBe(
      transcript,
    );
    await expect(adapterFor('claude').usage!.resolveTranscriptPath!({ sessionLogDir: root, sessionId: 'missing' })).resolves.toBeNull();
  });
});

describe("claude's incremental session-log tail reader (#217)", () => {
  const assistant = (model: string, u: Record<string, number>, id: string) =>
    JSON.stringify({ type: 'assistant', message: { id, model, usage: u } }) + '\n';

  /** A fresh claude home + root-transcript path for session `S` running in `/w`. */
  const setup = (S: string) => {
    const home = mkdtempSync(join(tmpdir(), 'claude-tail-'));
    const dir = join(home, '-w');
    mkdirSync(dir, { recursive: true });
    const rootFile = join(dir, `${S}.jsonl`);
    const reader = adapterFor('claude').usage!.createTailReader!({ sessionLogDir: home, cwd: '/w', sessionId: S });
    return { home, dir, rootFile, reader };
  };

  it('folds only newly-appended bytes across ticks, and dedupes a repeated message id', async () => {
    const { rootFile, reader } = setup('inc1');

    // No log yet: null, and latest() is null before the first sample.
    expect(reader.latest()).toBeNull();
    expect(await reader.sample()).toBeNull();

    writeFileSync(rootFile, assistant('claude-opus-4-8', { input_tokens: 100, output_tokens: 10 }, 'm1'));
    const first = await reader.sample();
    expect(first!.usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(first!.tree.contextTokens).toBe(100);
    // latest() serves that same build with no further I/O.
    expect(reader.latest()).toBe(first);

    // Append a second, distinct message — only the appended bytes are folded in.
    appendFileSync(rootFile, assistant('claude-opus-4-8', { input_tokens: 30, output_tokens: 3 }, 'm2'));
    const second = await reader.sample();
    expect(second!.usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 130, outputTokens: 13 });
    expect(second!.tree.contextTokens).toBe(30); // latest message's input-side footprint

    // A chunked assistant message repeats its id across ticks: deduped, not re-added.
    appendFileSync(rootFile, assistant('claude-opus-4-8', { input_tokens: 30, output_tokens: 3 }, 'm2'));
    const third = await reader.sample();
    expect(third!.usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 130, outputTokens: 13 });
  });

  it('holds back a mid-write partial line (invalid JSON) until it completes', async () => {
    const { rootFile, reader } = setup('inc2');
    const line = assistant('claude-opus-4-8', { input_tokens: 50, output_tokens: 5 }, 'p1'); // ends with '\n'

    // Only the first half of the line is on disk: invalid JSON, so nothing counts yet.
    const half = Math.floor(line.length / 2);
    writeFileSync(rootFile, line.slice(0, half));
    const partial = await reader.sample();
    expect(partial!.usage.models).toEqual({});

    // The rest (and its newline) lands: the now-complete line folds in exactly once.
    appendFileSync(rootFile, line.slice(half));
    const complete = await reader.sample();
    expect(complete!.usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 50, outputTokens: 5 });
  });

  it('counts a complete final line that has no trailing newline — parity with the whole-file scan', async () => {
    const { rootFile, reader } = setup('inc4');
    // A whole log written at once with no trailing newline: still fully counted.
    writeFileSync(rootFile, assistant('claude-opus-4-8', { input_tokens: 70, output_tokens: 7 }, 'm1').trimEnd());
    const s = await reader.sample();
    expect(s!.usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 70, outputTokens: 7 });
  });

  it('re-scans from scratch when the log shrinks, not folding new content onto stale tokens', async () => {
    const { rootFile, reader } = setup('inc5');
    writeFileSync(
      rootFile,
      assistant('claude-opus-4-8', { input_tokens: 100, output_tokens: 10 }, 'a') +
        assistant('claude-opus-4-8', { input_tokens: 100, output_tokens: 10 }, 'b'),
    );
    const before = await reader.sample();
    expect(before!.usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 200 });

    // The file is replaced with shorter, different content (truncation/rotation).
    writeFileSync(rootFile, assistant('claude-haiku-4-5', { input_tokens: 5, output_tokens: 1 }, 'c'));
    const after = await reader.sample();
    expect(after!.usage.models['claude-haiku-4-5']).toMatchObject({ inputTokens: 5 });
    // The old opus tokens are gone — not carried across the truncation.
    expect(after!.usage.models['claude-opus-4-8']).toBeUndefined();
  });

  it('picks up a Subagent that appears after the first tick and rolls its tokens up', async () => {
    const { dir, rootFile, reader } = setup('inc3');
    writeFileSync(rootFile, assistant('claude-opus-4-8', { input_tokens: 100, output_tokens: 10 }, 'm1'));

    const s1 = await reader.sample();
    expect(s1!.tree.children).toHaveLength(0);

    // A Subagent's transcript + meta land on a later tick.
    const subs = join(dir, 'inc3', 'subagents');
    mkdirSync(subs, { recursive: true });
    writeFileSync(join(subs, 'agent-a1.jsonl'), assistant('claude-haiku-4-5', { input_tokens: 20, output_tokens: 2 }, 's1'));
    writeFileSync(join(subs, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 't1', spawnDepth: 1 }));

    const s2 = await reader.sample();
    expect(s2!.tree.children.map((c) => c.id)).toEqual(['a1']);
    expect(s2!.tree.children[0]).toMatchObject({ name: 'Explore', model: 'claude-haiku-4-5', depth: 1 });
    // Flat Usage rolls the Subagent's tokens into the run (the undercount fix, #48).
    expect(s2!.usage.models['claude-haiku-4-5']).toMatchObject({ inputTokens: 20, outputTokens: 2 });
  });
});

describe("codex's incremental rollout tail reader (#217)", () => {
  const turn = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model, effort: 'low' } });
  const tokenCount = (input: number, cached: number, output: number, last: number) =>
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
          last_token_usage: { input_tokens: last, cached_input_tokens: 0, output_tokens: 0 },
        },
      },
    });

  /** A codex sessions root + dated rollout path for session `S`. */
  const setup = (S: string) => {
    const root = mkdtempSync(join(tmpdir(), 'codex-tail-'));
    const day = join(root, '2026', '07', '14');
    mkdirSync(day, { recursive: true });
    const file = join(day, `rollout-x-${S}.jsonl`);
    const reader = adapterFor('codex').usage!.createTailReader!({ sessionLogDir: root, cwd: '/w', sessionId: S });
    return { file, reader };
  };

  it('folds only newly-appended rollout bytes across ticks and never double-counts a re-read line', async () => {
    const { file, reader } = setup('s1');
    expect(reader.latest()).toBeNull();
    expect(await reader.sample()).toBeNull(); // rollout not written yet

    writeFileSync(file, turn('gpt-5.6-sol') + '\n' + tokenCount(16173, 9984, 5, 16173) + '\n');
    const first = await reader.sample();
    // Rollout input_tokens include cached reads; ModelUsage.inputTokens is uncached-only.
    expect(first!.usage.models['gpt-5.6-sol']).toEqual({ inputTokens: 6189, outputTokens: 5, cacheReadTokens: 9984, cacheWriteTokens: 0 });
    expect(first!.tree.contextTokens).toBe(16173);
    expect(reader.latest()).toBe(first);

    // A second turn appended (cumulative counter) — only the delta is attributed.
    appendFileSync(file, turn('gpt-5.4-mini') + '\n' + tokenCount(31723, 15488, 26, 15550) + '\n');
    const second = await reader.sample();
    expect(second!.usage.models).toEqual({
      'gpt-5.6-sol': { inputTokens: 6189, outputTokens: 5, cacheReadTokens: 9984, cacheWriteTokens: 0 },
      'gpt-5.4-mini': { inputTokens: 10046, outputTokens: 21, cacheReadTokens: 5504, cacheWriteTokens: 0 },
    });
    expect(second!.tree.contextTokens).toBe(15550);

    // A no-op sample (nothing appended) must not shift the cumulative totals.
    const third = await reader.sample();
    expect(third!.usage.models).toEqual(second!.usage.models);
  });

  it('counts a complete final rollout line with no trailing newline, then does not double-count it', async () => {
    const { file, reader } = setup('s2');
    // Whole content at once, no trailing newline (parity with the whole-file scan).
    writeFileSync(file, turn('gpt-5.6-sol') + '\n' + tokenCount(16173, 9984, 5, 16173));
    const s1 = await reader.sample();
    expect(s1!.usage.models['gpt-5.6-sol']).toEqual({ inputTokens: 6189, outputTokens: 5, cacheReadTokens: 9984, cacheWriteTokens: 0 });

    // The newline lands on a later tick; the cumulative-delta baseline makes the
    // re-fold a zero delta — no double count.
    appendFileSync(file, '\n');
    const s2 = await reader.sample();
    expect(s2!.usage.models['gpt-5.6-sol']).toEqual({ inputTokens: 6189, outputTokens: 5, cacheReadTokens: 9984, cacheWriteTokens: 0 });
  });

  it('holds back a mid-write partial rollout line (invalid JSON) until it completes', async () => {
    const { file, reader } = setup('s3');
    const tc = tokenCount(16173, 9984, 5, 16173);
    const half = Math.floor(tc.length / 2);
    writeFileSync(file, turn('gpt-5.6-sol') + '\n' + tc.slice(0, half));
    const partial = await reader.sample();
    expect(partial!.usage.models).toEqual({}); // the token_count line isn't complete yet

    appendFileSync(file, tc.slice(half) + '\n');
    const complete = await reader.sample();
    expect(complete!.usage.models['gpt-5.6-sol']).toEqual({ inputTokens: 6189, outputTokens: 5, cacheReadTokens: 9984, cacheWriteTokens: 0 });
  });
});
