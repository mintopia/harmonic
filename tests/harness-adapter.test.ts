import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { adapterFor } from '../src/execution/harness/adapter.js';

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
      model: 'gpt-5.4-mini',
      model_reasoning_effort: 'low',
    });
    expect(JSON.parse(adapterFor('codex').spawnEnv(spawnInput('gpt-5.6-sol')).CODEX_CONFIG!)).toEqual({
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

  it('copilot spawn tweaks disable auto-update and point the OTel exporter at the usage log — never a --model-style pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'copilot-otel-'));
    const env = adapterFor('copilot').spawnEnv({
      model: 'claude-haiku-4.5',
      cwd: '/tmp/my.work_dir',
      sessionLogDir: join(root, 'otel'),
    });
    // The CLI updated itself mid-spike; runs must be reproducible.
    expect(env.COPILOT_AUTO_UPDATE).toBe('false');
    // The exporter path is the Usage Collector's session log — the two
    // must derive the same file from the same run inputs.
    expect(env.COPILOT_OTEL_FILE_EXPORTER_PATH).toBe(
      adapterFor('copilot').usage!.sessionLogFile({
        sessionLogDir: join(root, 'otel'),
        cwd: '/tmp/my.work_dir',
        sessionId: 'any',
      }),
    );
    // The exporter silently drops spans if the directory is missing, and
    // creates the file lazily — spawnEnv pre-creates it so the usage
    // flush-race retry has a file to re-read on a directory's first run.
    expect(existsSync(env.COPILOT_OTEL_FILE_EXPORTER_PATH!)).toBe(true);
    // Spike capture 13: --model/COPILOT_MODEL falsify the session's
    // reported model without changing it. The pin goes via set_model only.
    expect(env.COPILOT_MODEL).toBeUndefined();
  });

  it('copilot registers the MCP server over ACP with the Run Key bearer header', () => {
    // Verified end-to-end in the spike (capture 5): every MCP request
    // arrived with the Authorization header.
    expect(adapterFor('copilot').mcpServers({ url: 'http://127.0.0.1:1/mcp', token: 'rk' })).toEqual([
      {
        name: 'harmonic',
        type: 'http',
        url: 'http://127.0.0.1:1/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer rk' }],
      },
    ]);
  });

  it("copilot's Usage Collector keys the OTel log by cwd slug and needs a sessionId to attribute spans", () => {
    const usage = adapterFor('copilot').usage!;
    expect(usage.sessionLogFile({ sessionLogDir: '/otel', cwd: '/tmp/my.work_dir', sessionId: 's1' })).toBe(
      '/otel/-tmp-my-work-dir.jsonl',
    );
    // No sessionId (spawn died before session/new): spans cannot be
    // attributed to this run, so there is no log to read.
    expect(usage.sessionLogFile({ sessionLogDir: '/otel', cwd: '/w', sessionId: null })).toBeNull();
  });

  it("copilot's Usage Collector aggregates OTel chat spans by serving model, with the cache split and AI Units", () => {
    // Span shapes verbatim from the spike's OTel excerpts (captures 3/4),
    // trimmed to the attributes the collector reads.
    const S = '574df71c-25b3-4829-b01a-4dc8d50f47e8';
    const span = (attributes: Record<string, unknown>) => JSON.stringify({ type: 'span', attributes });
    const lines = [
      // First call of a session: no cache attributes at all (omit-when-zero).
      span({
        'gen_ai.operation.name': 'chat',
        'gen_ai.conversation.id': S,
        'gen_ai.request.model': 'auto',
        'gen_ai.response.model': 'gpt-5-mini',
        'gen_ai.usage.input_tokens': 35068,
        'gen_ai.usage.output_tokens': 4539,
        'gen_ai.usage.reasoning.output_tokens': 4480,
        'github.copilot.nano_aiu': 1784500000.0,
      }),
      // Later call: cache_read present; input_tokens is TOTAL input.
      span({
        'gen_ai.operation.name': 'chat',
        'gen_ai.conversation.id': S,
        'gen_ai.request.model': 'auto',
        'gen_ai.response.model': 'gpt-5-mini',
        'gen_ai.usage.input_tokens': 39727,
        'gen_ai.usage.output_tokens': 783,
        'gen_ai.usage.cache_read.input_tokens': 39552,
        'github.copilot.nano_aiu': 259855000.0,
      }),
      // Served by a different model, with a cache write.
      span({
        'gen_ai.operation.name': 'chat',
        'gen_ai.conversation.id': S,
        'gen_ai.request.model': 'auto',
        'gen_ai.response.model': 'claude-haiku-4.5',
        'gen_ai.usage.input_tokens': 48503,
        'gen_ai.usage.output_tokens': 145,
        'gen_ai.usage.cache_creation.input_tokens': 48494,
        'github.copilot.nano_aiu': 6135150000.0,
      }),
      // Another run sharing the file (direct mode): filtered out.
      span({
        'gen_ai.operation.name': 'chat',
        'gen_ai.conversation.id': 'other-session',
        'gen_ai.response.model': 'gpt-5-mini',
        'gen_ai.usage.input_tokens': 999999,
        'gen_ai.usage.output_tokens': 999999,
        'github.copilot.nano_aiu': 9e9,
      }),
      // The exporter interleaves metric lines; and tolerate log noise.
      JSON.stringify({ type: 'metric', name: 'gen_ai.client.token.usage', dataPoints: [] }),
      'not json',
    ];
    const dir = mkdtempSync(join(tmpdir(), 'copilot-otel-log-'));
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, lines.join('\n'));

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
    expect(adapterFor('copilot').usage!.modelsFromSessionLog(join(dir, 'missing.jsonl'), S)).toEqual({});
    // No sessionId to filter on: nothing is attributable, never guess.
    expect(adapterFor('copilot').usage!.modelsFromSessionLog(file, null)).toEqual({});
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
});
