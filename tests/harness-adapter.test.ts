import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterFor } from '../src/execution/harness/registry.js';
import { writeCopilotUsageDb } from './helpers.js';

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
    // An unpinned Copilot session inherits the operator's persisted
    // settings.json model, so the pin must be sent even for 'auto'.
    expect(adapterFor('copilot').sessionModelId?.('claude-haiku-4.5')).toBe('claude-haiku-4.5');
    expect(adapterFor('copilot').sessionModelId?.('auto')).toBe('auto');
    expect(adapterFor('claude').sessionModelId).toBeUndefined();
    expect(adapterFor('codex').sessionModelId).toBeUndefined();
  });

  it('copilot spawn tweaks disable auto-update and never pin via --model or OTel', () => {
    const env = adapterFor('copilot').spawnEnv(spawnInput('claude-haiku-4.5'));
    expect(env.COPILOT_AUTO_UPDATE).toBe('false');
    // --model/COPILOT_MODEL falsify Copilot's reported model without changing it.
    expect(env.COPILOT_MODEL).toBeUndefined();
    expect(env).not.toHaveProperty('COPILOT_OTEL_FILE_EXPORTER_PATH');
  });

  it.each(['claude', 'codex', 'copilot'])(
    '%s registers the MCP server over ACP with the Attempt Key bearer header',
    (harness) => {
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
    expect(adapterFor('copilot').usage!.modelsFromSessionLog(file, null)).toEqual({});
  });

  it("copilot's parse() builds a Subagent tree from the store + events.jsonl and rolls Subagent tokens up", () => {
    const S = 'parse-session';
    const home = mkdtempSync(join(tmpdir(), 'copilot-home-'));
    writeCopilotUsageDb(join(home, 'session-store.db'), [
      { session_id: S, model: 'gpt-5-mini', input_tokens: 1000, output_tokens: 100, total_nano_aiu: 500000000 },
      { session_id: S, model: 'gpt-5-mini', input_tokens: 2000, output_tokens: 200, cache_read_tokens: 1500, total_nano_aiu: 100000000 },
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
        JSON.stringify({ type: 'subagent.started', data: { toolCallId: 'tool_pending', agentName: 'laravel-specialist' } }),
        'not json',
      ].join('\n'),
    );

    const parsed = adapterFor('copilot').usage!.parse!({ sessionLogDir: home, cwd: '/w', sessionId: S })!;

    expect(parsed.usage.models['claude-haiku-4.5']).toMatchObject({ inputTokens: 500, outputTokens: 50, aiUnits: 0.3 });
    expect(parsed.usage.models['gpt-5-mini']).toMatchObject({ inputTokens: 1000 + (2000 - 1500) });
    expect(parsed.usage.totals?.aiUnits).toBeCloseTo(0.9, 10);

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

    expect(adapterFor('copilot').usage!.parse!({ cwd: '/w', sessionId: 'nope', sessionLogDir: home })).toBeNull();
  });

  it("codex's Usage Collector reads the per-model breakdown off the ACP prompt result", () => {
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
    expect(adapterFor('codex').usage!.modelsFromPromptResult!({})).toEqual({});
  });

  it("codex's Usage Collector finds the rollout log by the sessionId embedded in its filename", () => {
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

    // Rollout `input_tokens` includes cached reads; ModelUsage.inputTokens is uncached-only.
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
      tc(100, 40, 3),
      turn('m1'),
      tc(200, 80, 10),
      tc(50, 20, 5),
    ];
    const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-edge-'));
    const file = join(dir, 'rollout-x-s2.jsonl');
    writeFileSync(file, lines.join('\n'));

    expect(adapterFor('codex').usage!.modelsFromSessionLog(file)).toEqual({
      m1: { inputTokens: 90, outputTokens: 12, cacheReadTokens: 60, cacheWriteTokens: 0 },
    });
  });

  it("codex's parse() builds a root tree with context fill and the dominant model", () => {
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
    expect(parsed.usage.models).toEqual({
      'gpt-5.6-sol': { inputTokens: 6189, outputTokens: 5, cacheReadTokens: 9984, cacheWriteTokens: 0 },
      'gpt-5.4-mini': { inputTokens: 10046, outputTokens: 21, cacheReadTokens: 5504, cacheWriteTokens: 0 },
    });
    expect(parsed.tree).toMatchObject({ id: 's1', depth: 0, model: 'gpt-5.6-sol', contextTokens: 15550, children: [] });
    expect(parsed.tree.usage).toEqual({ inputTokens: 16235, outputTokens: 26, cacheReadTokens: 15488, cacheWriteTokens: 0 });
    expect(adapterFor('codex').usage!.parse!({ sessionLogDir: root, cwd: '/w', sessionId: 'missing' })).toBeNull();
  });

  it("codex's parse() discovers Subagent rollouts without counting their forked parent history", () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-subagent-parse-'));
    const day = join(root, '2026', '08', '24');
    mkdirSync(day, { recursive: true });
    const tokenCount = (input: number, output: number) =>
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } } },
      });
    const turn = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model } });
    writeFileSync(
      join(day, 'rollout-x-root.jsonl'),
      [JSON.stringify({ type: 'session_meta', payload: { id: 'root' } }), turn('gpt-5.6-sol'), tokenCount(100, 10)].join('\n'),
    );
    writeFileSync(
      join(day, 'rollout-x-child.jsonl'),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'child',
            parent_thread_id: 'root',
            source: { subagent: { thread_spawn: { agent_path: '/root/issue_investigation' } } },
          },
        }),
        turn('gpt-5.6-sol'),
        tokenCount(100, 10),
        JSON.stringify({ type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } }),
        turn('gpt-5.6-mini'),
        tokenCount(30, 3),
      ].join('\n'),
    );

    const parsed = adapterFor('codex').usage!.parse!({ sessionLogDir: root, cwd: '/w', sessionId: 'root' })!;
    expect(parsed.tree).toMatchObject({ id: 'root', children: [{ id: 'child', name: '/root/issue_investigation', depth: 1 }] });
    expect(parsed.usage.models).toEqual({
      'gpt-5.6-sol': { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      'gpt-5.6-mini': { inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
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

    writeFileSync(
      join(dir, `${S}.jsonl`),
      [
        assistant('claude-opus-4-8', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 }),
        toolResult('toolu_sub1'),
      ].join('\n'),
    );
    writeFileSync(join(subs, 'agent-a1.jsonl'), assistant('claude-opus-4-8', { input_tokens: 50, output_tokens: 5 }));
    writeFileSync(join(subs, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_sub1', spawnDepth: 1 }));
    writeFileSync(join(subs, 'agent-a2.jsonl'), assistant('claude-haiku-4-5', { input_tokens: 20, output_tokens: 2 }));
    writeFileSync(join(subs, 'agent-a2.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_sub2', parentAgentId: 'a1', spawnDepth: 2 }));
    writeFileSync(join(subs, 'workflows', 'wf_x', 'agent-a3.jsonl'), assistant('claude-opus-4-8', { input_tokens: 30, output_tokens: 3 }));
    writeFileSync(join(subs, 'workflows', 'wf_x', 'agent-a3.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));
    writeFileSync(join(subs, 'agent-a4.meta.json'), JSON.stringify({ agentType: 'code-reviewer', toolUseId: 'toolu_sub4', spawnDepth: 1 }));

    const parsed = adapterFor('claude').usage!.parse!({ sessionLogDir: home, cwd: '/w', sessionId: S })!;

    expect(parsed.usage.models['claude-opus-4-8']).toEqual({ inputTokens: 100 + 50 + 30, outputTokens: 10 + 5 + 3, cacheReadTokens: 5, cacheWriteTokens: 2 });
    expect(parsed.usage.models['claude-haiku-4-5']).toEqual({ inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });

    expect(parsed.tree).toMatchObject({ id: S, depth: 0, model: 'claude-opus-4-8', contextTokens: 107 });
    expect(parsed.tree.usage).toEqual({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2 });

    const byId = Object.fromEntries(parsed.tree.children.map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual(['a1', 'a3', 'a4']);
    expect(byId.a1).toMatchObject({ name: 'general-purpose', status: 'inactive', depth: 1 });
    expect(byId.a3).toMatchObject({ name: 'workflow-subagent', status: 'active' });
    expect(byId.a4).toMatchObject({ status: 'active' });
    expect(byId.a4!.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(byId.a1!.children).toHaveLength(1);
    expect(byId.a1!.children[0]).toMatchObject({ id: 'a2', name: 'Explore', model: 'claude-haiku-4-5', status: 'active', depth: 2 });

    expect(adapterFor('claude').usage!.parse!({ sessionLogDir: home, cwd: '/w', sessionId: 'missing' })).toBeNull();
  });

  it("claude's Usage Collector locates the session log by the cwd-slug convention", () => {
    const usage = adapterFor('claude').usage!;
    expect(
      usage.sessionLogFile({ sessionLogDir: '/logs', cwd: '/tmp/my.work_dir', sessionId: 'abc-123' }),
    ).toBe('/logs/-tmp-my-work-dir/abc-123.jsonl');
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
      realpathSync(transcript),
    );
    await expect(adapterFor('claude').usage!.resolveTranscriptPath!({ sessionLogDir: root, sessionId: 'missing' })).resolves.toBeNull();
  });
});

describe("claude's incremental session-log tail reader (#217)", () => {
  const assistant = (model: string, u: Record<string, number>, id: string) =>
    JSON.stringify({ type: 'assistant', message: { id, model, usage: u } }) + '\n';

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

    expect(reader.latest()).toBeNull();
    expect(await reader.sample()).toBeNull();

    writeFileSync(rootFile, assistant('claude-opus-4-8', { input_tokens: 100, output_tokens: 10 }, 'm1'));
    const first = await reader.sample();
    expect(first!.usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(first!.tree.contextTokens).toBe(100);
    expect(reader.latest()).toBe(first);

    appendFileSync(rootFile, assistant('claude-opus-4-8', { input_tokens: 30, output_tokens: 3 }, 'm2'));
    const second = await reader.sample();
    expect(second!.usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 130, outputTokens: 13 });
    expect(second!.tree.contextTokens).toBe(30);

    appendFileSync(rootFile, assistant('claude-opus-4-8', { input_tokens: 30, output_tokens: 3 }, 'm2'));
    const third = await reader.sample();
    expect(third!.usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 130, outputTokens: 13 });
  });

  it('holds back a mid-write partial line (invalid JSON) until it completes', async () => {
    const { rootFile, reader } = setup('inc2');
    const line = assistant('claude-opus-4-8', { input_tokens: 50, output_tokens: 5 }, 'p1');

    const half = Math.floor(line.length / 2);
    writeFileSync(rootFile, line.slice(0, half));
    const partial = await reader.sample();
    expect(partial!.usage.models).toEqual({});

    appendFileSync(rootFile, line.slice(half));
    const complete = await reader.sample();
    expect(complete!.usage.models['claude-opus-4-8']).toMatchObject({ inputTokens: 50, outputTokens: 5 });
  });

  it('counts a complete final line that has no trailing newline — parity with the whole-file scan', async () => {
    const { rootFile, reader } = setup('inc4');
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

    writeFileSync(rootFile, assistant('claude-haiku-4-5', { input_tokens: 5, output_tokens: 1 }, 'c'));
    const after = await reader.sample();
    expect(after!.usage.models['claude-haiku-4-5']).toMatchObject({ inputTokens: 5 });
    expect(after!.usage.models['claude-opus-4-8']).toBeUndefined();
  });

  it('picks up a Subagent that appears after the first tick and rolls its tokens up', async () => {
    const { dir, rootFile, reader } = setup('inc3');
    writeFileSync(rootFile, assistant('claude-opus-4-8', { input_tokens: 100, output_tokens: 10 }, 'm1'));

    const s1 = await reader.sample();
    expect(s1!.tree.children).toHaveLength(0);

    const subs = join(dir, 'inc3', 'subagents');
    mkdirSync(subs, { recursive: true });
    writeFileSync(join(subs, 'agent-a1.jsonl'), assistant('claude-haiku-4-5', { input_tokens: 20, output_tokens: 2 }, 's1'));
    writeFileSync(join(subs, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 't1', spawnDepth: 1 }));

    const s2 = await reader.sample();
    expect(s2!.tree.children.map((c) => c.id)).toEqual(['a1']);
    expect(s2!.tree.children[0]).toMatchObject({ name: 'Explore', model: 'claude-haiku-4-5', depth: 1 });
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
    expect(await reader.sample()).toBeNull();

    writeFileSync(file, turn('gpt-5.6-sol') + '\n' + tokenCount(16173, 9984, 5, 16173) + '\n');
    const first = await reader.sample();
    expect(first!.usage.models['gpt-5.6-sol']).toEqual({ inputTokens: 6189, outputTokens: 5, cacheReadTokens: 9984, cacheWriteTokens: 0 });
    expect(first!.tree.contextTokens).toBe(16173);
    expect(reader.latest()).toBe(first);

    appendFileSync(file, turn('gpt-5.4-mini') + '\n' + tokenCount(31723, 15488, 26, 15550) + '\n');
    const second = await reader.sample();
    expect(second!.usage.models).toEqual({
      'gpt-5.6-sol': { inputTokens: 6189, outputTokens: 5, cacheReadTokens: 9984, cacheWriteTokens: 0 },
      'gpt-5.4-mini': { inputTokens: 10046, outputTokens: 21, cacheReadTokens: 5504, cacheWriteTokens: 0 },
    });
    expect(second!.tree.contextTokens).toBe(15550);

    const third = await reader.sample();
    expect(third!.usage.models).toEqual(second!.usage.models);
  });

  it('counts a complete final rollout line with no trailing newline, then does not double-count it', async () => {
    const { file, reader } = setup('s2');
    writeFileSync(file, turn('gpt-5.6-sol') + '\n' + tokenCount(16173, 9984, 5, 16173));
    const s1 = await reader.sample();
    expect(s1!.usage.models['gpt-5.6-sol']).toEqual({ inputTokens: 6189, outputTokens: 5, cacheReadTokens: 9984, cacheWriteTokens: 0 });

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
    expect(partial!.usage.models).toEqual({});

    appendFileSync(file, tc.slice(half) + '\n');
    const complete = await reader.sample();
    expect(complete!.usage.models['gpt-5.6-sol']).toEqual({ inputTokens: 6189, outputTokens: 5, cacheReadTokens: 9984, cacheWriteTokens: 0 });
  });

  it('picks up a Codex Subagent rollout that appears after the first tick', async () => {
    const { file, reader } = setup('root');
    writeFileSync(file, turn('gpt-5.6-sol') + '\n' + tokenCount(100, 0, 10, 100) + '\n');
    expect((await reader.sample())!.tree.children).toEqual([]);

    const child = join(file.slice(0, file.lastIndexOf('/')), 'rollout-x-child.jsonl');
    writeFileSync(
      child,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'child',
            parent_thread_id: 'root',
            source: { subagent: { thread_spawn: { agent_path: '/root/reviewer' } } },
          },
        }),
        JSON.stringify({ type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } }),
        turn('gpt-5.6-mini'),
        tokenCount(20, 0, 2, 20),
      ].join('\n'),
    );

    const updated = await reader.sample();
    expect(updated!.tree.children).toMatchObject([{ id: 'child', name: '/root/reviewer', depth: 1 }]);
    expect(updated!.usage.models['gpt-5.6-mini']).toMatchObject({ inputTokens: 20, outputTokens: 2 });
  });
});
