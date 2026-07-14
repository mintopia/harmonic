import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultDataDir } from '../../config.js';
import type { HarnessAdapter, ModelUsage } from './adapter.js';

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * The OTel file exporter is Copilot's Usage source (spike, issue 25): the
 * ACP prompt result is bare and the native session log carries no token
 * counts. Harmonic picks the path, keyed by cwd slug — direct-mode runs
 * of one directory share the file, so spans are attributed to a run by
 * `gen_ai.conversation.id`, which equals the ACP sessionId verbatim.
 */
function otelLogFile(sessionLogDir: string | undefined, cwd: string): string {
  const root = sessionLogDir ?? join(defaultDataDir(), 'copilot-otel');
  return join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-') + '.jsonl');
}

/** Copilot Harness Adapter, built on the issue-25 spike findings. */
export const copilotAdapter: HarnessAdapter = {
  // No model env here on purpose: --model and COPILOT_MODEL are ignored
  // in --acp mode, and --model falsifies session/new's reported
  // currentModelId without changing the session (spike capture 13). The
  // pin goes through sessionModelId below.
  spawnEnv: ({ cwd, sessionLogDir }) => {
    const file = otelLogFile(sessionLogDir, cwd);
    try {
      // The exporter writes nothing if the directory is missing, and
      // creates the file lazily — pre-create it (append-safe) so the
      // usage flush-race retry sees "log exists, keep re-reading" instead
      // of "no log is coming" on a directory's first run.
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '', { flag: 'a' });
    } catch {
      // Usage degrades to unavailable; never block the spawn.
    }
    return {
      // The CLI updated itself between two spike runs; keep runs reproducible.
      COPILOT_AUTO_UPDATE: 'false',
      COPILOT_OTEL_FILE_EXPORTER_PATH: file,
    };
  },

  // Sent for every run, 'auto' included: an unpinned ACP session inherits
  // the operator's persisted settings.json model, not auto (capture 13).
  // Auto-only plans accept and silently ignore the pin — which is exactly
  // what the model_mismatch check surfaces.
  sessionModelId: (model) => model,

  // Verified end-to-end in the spike (capture 5): every MCP request
  // arrived with the bearer header, so the Run Key needs zero setup.
  mcpServers: ({ url, token }) => [
    {
      name: 'harmonic',
      type: 'http',
      url,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
  ],

  usage: {
    /** Spans are attributed by conversation id: no sessionId, no log to read. */
    sessionLogFile({ sessionLogDir, cwd, sessionId }) {
      if (!sessionId) return null;
      return otelLogFile(sessionLogDir, cwd);
    },

    /**
     * Aggregate `chat` spans by `gen_ai.response.model` — the model that
     * actually served the call. `input_tokens` is TOTAL input; the
     * omit-when-zero cache attributes are subtracted to keep the
     * uncached-input convention Claude and Codex use. `nano_aiu` sums to
     * per-model AI Units (spike Q7).
     */
    modelsFromSessionLog(file, sessionId) {
      if (!sessionId || !existsSync(file)) return {};

      const models: Record<string, ModelUsage> = {};
      // Summed in integer nano-units; divided once to keep floats exact.
      const nano: Record<string, number> = {};
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry?.type !== 'span') continue;
        const attrs = entry.attributes;
        if (attrs?.['gen_ai.operation.name'] !== 'chat') continue;
        if (attrs['gen_ai.conversation.id'] !== sessionId) continue;
        const model = attrs['gen_ai.response.model'];
        if (typeof model !== 'string') continue;
        const bucket = (models[model] ??= {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
        const cacheRead = num(attrs['gen_ai.usage.cache_read.input_tokens']);
        const cacheWrite = num(attrs['gen_ai.usage.cache_creation.input_tokens']);
        bucket.inputTokens += Math.max(0, num(attrs['gen_ai.usage.input_tokens']) - cacheRead - cacheWrite);
        bucket.outputTokens += num(attrs['gen_ai.usage.output_tokens']);
        bucket.cacheReadTokens += cacheRead;
        bucket.cacheWriteTokens += cacheWrite;
        if (typeof attrs['github.copilot.nano_aiu'] === 'number') {
          nano[model] = (nano[model] ?? 0) + attrs['github.copilot.nano_aiu'];
        }
      }
      for (const [model, units] of Object.entries(nano)) models[model]!.aiUnits = units / 1e9;
      return models;
    },

    // No `_meta.<harness>.toolName` equivalent exists (spike finding);
    // the generic `title`/`kind` fallback is the right source.
    toolName() {
      return null;
    },
  },
};
