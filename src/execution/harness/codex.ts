import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dominantModel, foldModels, usageFromModels, type ParsedSession, type ProcessNode } from '../usage.js';
import type { HarnessAdapter, ModelUsage, SessionTailReader } from './adapter.js';
import { LineCursor, type LineAccumulator } from './incremental-log.js';

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

interface RolloutScan {
  models: Record<string, ModelUsage>;
  contextTokens: number | null;
}

/**
 * The running fold of a rollout log: per-model usage (turn_context ×
 * token_count deltas) plus the latest context-window fill, updated line by
 * line so a whole-file scan (`scanRollout`) and an incremental tail
 * (`LineCursor`, #217) share the exact accounting. `turn_context` names the
 * model driving the turn; `event_msg/token_count` carries the *cumulative*
 * session usage, so each entry's delta against the previous one is the
 * current model's spend. Rollout `input_tokens` includes cached reads;
 * ModelUsage.inputTokens is uncached-only. No cache-write figure exists
 * (report 0). Context fill is the most recent request's input footprint
 * (`last_token_usage.input_tokens`, cache included) — how full the window
 * is right now.
 *
 * The `prev` cumulative baseline is what makes re-folding the exact same line
 * a no-op (its delta is 0), so the tail cursor can speculatively re-fold the
 * trailing line without double-counting.
 *
 * ponytail: the rollout's `model_context_window` (window *size*) is not
 * surfaced — ProcessNode has no capacity field (T1/#47) and window size
 * already comes from config (`harnesses.*.models` → `contextWindow`).
 * Read it here if a node ever needs a per-served-model capacity.
 */
class RolloutAcc implements LineAccumulator {
  readonly models: Record<string, ModelUsage> = {};
  private model: string | null = null;
  private contextTokens: number | null = null;
  private readonly prev = { input: 0, cached: 0, output: 0 };

  fold(line: string): void {
    if (!line.trim()) return;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (entry?.type === 'turn_context' && typeof entry.payload?.model === 'string') {
      this.model = entry.payload.model;
      return;
    }
    const info = entry?.type === 'event_msg' && entry.payload?.type === 'token_count' ? entry.payload.info : null;
    const total = info?.total_token_usage;
    if (!total) return;
    if (typeof info.last_token_usage?.input_tokens === 'number') this.contextTokens = info.last_token_usage.input_tokens;
    const input = num(total.input_tokens);
    const cached = num(total.cached_input_tokens);
    const output = num(total.output_tokens);
    // A shrinking cumulative counter means it was reset (session resume):
    // the entry is its own delta. Never emit negatives.
    const reset = input < this.prev.input || cached < this.prev.cached || output < this.prev.output;
    const delta = reset
      ? { input, cached, output }
      : { input: input - this.prev.input, cached: cached - this.prev.cached, output: output - this.prev.output };
    // Pre-turn_context spend is unattributable: drop it (never guess),
    // but still advance the baseline so it can't leak into a model.
    if (this.model) {
      const bucket = (this.models[this.model] ??= {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      bucket.inputTokens += delta.input - delta.cached;
      bucket.cacheReadTokens += delta.cached;
      bucket.outputTokens += delta.output;
    }
    this.prev.input = input;
    this.prev.cached = cached;
    this.prev.output = output;
  }

  snapshot(): RolloutScan {
    return { models: this.models, contextTokens: this.contextTokens };
  }
}

/** One whole-file pass over a rollout log (the run-end `collectUsage` path). */
function scanRollout(file: string): RolloutScan {
  const acc = new RolloutAcc();
  if (!existsSync(file)) return acc.snapshot();
  for (const line of readFileSync(file, 'utf8').split('\n')) acc.fold(line);
  return acc.snapshot();
}

/**
 * Codex has no Subagent concept, so its Process Tree is a single root node:
 * its own tokens are the whole session and its context fill is the latest
 * request's input footprint. Shared by the whole-file `parse` and the
 * incremental `CodexSessionTailReader`.
 *
 * ponytail: single-model-per-node — a session that switched models (manual
 * resume with a different pin) collapses the node's tokens under its dominant
 * model. The flat `usage` keeps the true per-model split; only the tree node
 * is lossy. Split per model if the Activity view ever needs exact per-node
 * pricing.
 */
function buildRolloutTree(rootId: string, scan: RolloutScan): ParsedSession {
  const root: ProcessNode = {
    id: rootId,
    name: 'root',
    model: dominantModel(scan.models) ?? 'unknown',
    usage: foldModels(scan.models),
    contextTokens: scan.contextTokens,
    status: 'active',
    depth: 0,
    toolUseId: null,
    children: [],
  };
  return { usage: usageFromModels(scan.models), tree: root } satisfies ParsedSession;
}

/**
 * The incremental, async live reader for a codex run's rollout log (#217): a
 * single `LineCursor` folds only newly-appended bytes each tick instead of
 * re-reading the whole rollout, off the event loop. The rollout filename
 * embeds an unpredictable timestamp, so the path can't be resolved until the
 * file exists — keep re-resolving until it appears, then the path is stable.
 */
class CodexSessionTailReader implements SessionTailReader {
  private cursor: LineCursor<RolloutAcc> | null = null;
  private cached: ParsedSession | null = null;
  private inflight: Promise<ParsedSession | null> | null = null;

  constructor(private readonly input: { sessionLogDir?: string | undefined; cwd: string; sessionId: string }) {}

  latest(): ParsedSession | null {
    return this.cached;
  }

  sample(): Promise<ParsedSession | null> {
    // Serialize onto the cursor: a slow tick and an on-demand read must never
    // advance the same byte offset concurrently. Chain past whatever ran last.
    const run = (this.inflight ?? Promise.resolve(null)).then(
      () => this.doSample(),
      () => this.doSample(),
    );
    this.inflight = run;
    return run;
  }

  private async doSample(): Promise<ParsedSession | null> {
    if (!this.cursor) {
      const file = codexAdapter.usage!.sessionLogFile(this.input);
      if (!file) return this.cached; // rollout not written yet → stays null
      this.cursor = new LineCursor(file, () => new RolloutAcc());
    }
    await this.cursor.advance();
    this.cached = buildRolloutTree(this.input.sessionId, this.cursor.acc.snapshot());
    return this.cached;
  }
}

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
      name: 'harmonic',
      type: 'http',
      url,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
  ],

  usage: {
    /**
     * Rollout parse into rolled-up Usage + Process Tree (ADR 0009), for the
     * one-shot run-end `collectUsage`. Returns null when the rollout has not
     * appeared yet. See `buildRolloutTree` for the single-node tree shape.
     */
    parse(input) {
      const file = codexAdapter.usage!.sessionLogFile(input);
      if (!file || !existsSync(file)) return null;
      return buildRolloutTree(input.sessionId ?? file, scanRollout(file));
    },

    /** The live path (#217): an incremental, off-the-event-loop tailer that
     *  folds only newly-appended rollout bytes each tick, versus `parse`'s
     *  whole-file re-scan. */
    createTailReader(input) {
      return new CodexSessionTailReader(input);
    },

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
        // ACP prompt result reports uncached `inputTokens` already (see the
        // docstring above) — unlike the rollout-log path, so no subtraction.
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

    // Rollout parse (audit fallback — the prompt result is the primary
    // source): per-model usage from turn_context × token_count deltas.
    modelsFromSessionLog(file) {
      return scanRollout(file).models;
    },

    // No `_meta.<harness>.toolName` equivalent exists (spike finding);
    // the generic `title`/`kind` fallback is the right source.
    toolName() {
      return null;
    },
  },
};
