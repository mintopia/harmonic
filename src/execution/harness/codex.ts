import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessAdapter, ModelUsage } from './adapter.js';

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** Entries of `dir`, newest name first; [] when unreadable. */
function entriesNewestFirst(dir: string): string[] {
  try {
    return readdirSync(dir).sort().reverse();
  } catch {
    return [];
  }
}

/**
 * Our model ids use Codex's ACP modelId grammar `<model>[<effort>]`
 * (spike, issue 22); effort is optional.
 */
function splitModelId(model: string): { base: string; effort: string | null } {
  const match = /^(.*)\[([^\]]+)\]$/.exec(model);
  return match ? { base: match[1]!, effort: match[2]! } : { base: model, effort: null };
}

/** Codex Harness Adapter, built on the issue-22 spike findings. */
export const codexAdapter: HarnessAdapter = {
  // CODEX_CONFIG is a JSON object merged into the Codex session config —
  // the verified spawn-time pinning mechanism. The model actually used is
  // observable on the prompt result's `_meta.quota.model_usage`.
  spawnEnv: ({ model }) => {
    const { base, effort } = splitModelId(model);
    return {
      CODEX_CONFIG: JSON.stringify({ model: base, ...(effort ? { model_reasoning_effort: effort } : {}) }),
    };
  },

  // Verified end-to-end in the spike: every MCP request arrives with the
  // bearer header, so the Run Key mechanism needs zero operator setup.
  mcpServers: ({ url, token }) => [
    {
      name: 'agentdeck',
      type: 'http',
      url,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
  ],

  usage: {
    /**
     * Codex attributes usage per model on the prompt result itself —
     * `_meta.quota.model_usage` (spike finding); `inputTokens` there is
     * uncached input, `cachedInputTokens` the cache reads, and no
     * cache-write figure exists (report 0).
     */
    modelsFromPromptResult(result) {
      const entries = (result as any)?._meta?.quota?.model_usage;
      if (!Array.isArray(entries)) return {};
      const models: Record<string, ModelUsage> = {};
      for (const entry of entries) {
        if (typeof entry?.model !== 'string' || !entry?.token_count) continue;
        const bucket = (models[entry.model] ??= {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
        bucket.inputTokens += num(entry.token_count.inputTokens);
        bucket.outputTokens += num(entry.token_count.outputTokens);
        bucket.cacheReadTokens += num(entry.token_count.cachedInputTokens);
      }
      return models;
    },

    /**
     * Rollout logs (audit fallback — the prompt result is the primary
     * source) live at `<root>/<YYYY>/<MM>/<DD>/rollout-<ts>-<sessionId>.jsonl`;
     * the ACP sessionId is embedded verbatim in the filename (spike
     * finding). The timestamp part is unknowable, so search the dated
     * tree, newest day first. Returning null when the file has not
     * appeared yet skips the flush-race retry; the boot-time
     * `backfillUsage` sweep is the backstop, and clean runs never get
     * here (the prompt result carries the breakdown).
     */
    sessionLogFile({ sessionLogDir, sessionId }) {
      if (!sessionId) return null;
      const codexHome = process.env.CODEX_HOME;
      const root =
        sessionLogDir ?? (codexHome ? join(codexHome, 'sessions') : join(homedir(), '.codex', 'sessions'));
      const suffix = `-${sessionId}.jsonl`;
      for (const year of entriesNewestFirst(root)) {
        for (const month of entriesNewestFirst(join(root, year))) {
          for (const day of entriesNewestFirst(join(root, year, month))) {
            for (const file of entriesNewestFirst(join(root, year, month, day))) {
              if (file.startsWith('rollout-') && file.endsWith(suffix)) {
                return join(root, year, month, day, file);
              }
            }
          }
        }
      }
      return null;
    },

    /**
     * `turn_context` entries name the model driving the turn;
     * `event_msg/token_count` entries carry the *cumulative* session
     * usage, so each entry's delta against the previous one is the
     * current model's spend. Rollout `input_tokens` includes cached
     * reads; ModelUsage.inputTokens is uncached-only. No cache-write
     * figure exists (report 0).
     */
    modelsFromSessionLog(file) {
      if (!existsSync(file)) return {};

      const models: Record<string, ModelUsage> = {};
      let model: string | null = null;
      const prev = { input: 0, cached: 0, output: 0 };
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry?.type === 'turn_context' && typeof entry.payload?.model === 'string') {
          model = entry.payload.model;
          continue;
        }
        const total = entry?.type === 'event_msg' && entry.payload?.type === 'token_count'
          ? entry.payload.info?.total_token_usage
          : null;
        if (!total) continue;
        const input = num(total.input_tokens);
        const cached = num(total.cached_input_tokens);
        const output = num(total.output_tokens);
        // A shrinking cumulative counter means it was reset (session
        // resume): the entry is its own delta. Never emit negatives.
        const reset = input < prev.input || cached < prev.cached || output < prev.output;
        const delta = reset
          ? { input, cached, output }
          : { input: input - prev.input, cached: cached - prev.cached, output: output - prev.output };
        // Pre-turn_context spend is unattributable: drop it (never guess),
        // but still advance the baseline so it can't leak into a model.
        if (model) {
          const bucket = (models[model] ??= {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          });
          bucket.inputTokens += delta.input - delta.cached;
          bucket.cacheReadTokens += delta.cached;
          bucket.outputTokens += delta.output;
        }
        prev.input = input;
        prev.cached = cached;
        prev.output = output;
      }
      return models;
    },

    // No `_meta.<harness>.toolName` equivalent exists (spike finding);
    // the generic `title`/`kind` fallback is the right source.
    toolName() {
      return null;
    },
  },
};
