import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterFor } from '../src/execution/harness/adapter.js';

describe('harness adapters', () => {
  it('claude spawn tweaks pin the model and strip the nested-session guard vars', () => {
    const env = adapterFor('claude').spawnEnv('claude-opus-4-8');
    expect(env.ANTHROPIC_MODEL).toBe('claude-opus-4-8');
    // Present-but-undefined so they override anything inherited from process.env.
    expect(env).toHaveProperty('CLAUDECODE', undefined);
    expect(env).toHaveProperty('CLAUDE_CODE_ENTRYPOINT', undefined);
  });

  it('copilot is a stub: no spawn tweaks beyond the generic AGENTDECK_MODEL', () => {
    expect(adapterFor('copilot').spawnEnv('claude-sonnet-5')).toEqual({});
  });

  it('copilot and unknown harnesses have no Usage Collector', () => {
    expect(adapterFor('copilot').usage).toBeNull();
    expect(adapterFor('mystery').usage).toBeNull();
  });

  it('codex spawn tweaks pin the model via CODEX_CONFIG, splitting the model[effort] grammar', () => {
    // Spike (issue 22): CODEX_CONFIG is a JSON object merged into the
    // session config; modelId grammar is `<model>[<effort>]`.
    expect(JSON.parse(adapterFor('codex').spawnEnv('gpt-5.4-mini[low]').CODEX_CONFIG!)).toEqual({
      model: 'gpt-5.4-mini',
      model_reasoning_effort: 'low',
    });
    expect(JSON.parse(adapterFor('codex').spawnEnv('gpt-5.6-sol').CODEX_CONFIG!)).toEqual({
      model: 'gpt-5.6-sol',
    });
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
