import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { copilotAdapter } from './copilot.js';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * The per-Harness Usage source (CONTEXT.md: Usage Collector): where the
 * native session log lives and how to read a per-model breakdown out of
 * it. The generic ACP-result path in usage.ts needs no collector.
 */
export interface UsageCollector {
  /**
   * Absolute path of a run's native session log, or null when it cannot
   * be derived. `sessionLogDir` is the operator override; the collector
   * supplies the harness's default root.
   */
  sessionLogFile(input: { sessionLogDir?: string | undefined; cwd: string; sessionId: string | null }): string | null;
  /** Per-model token usage parsed from the session log at `file`. */
  modelsFromSessionLog(file: string): Record<string, ModelUsage>;
  /**
   * Harness-preferred tool name for a tool_call update payload; null
   * defers to the generic `title`/`kind` fields.
   */
  toolName(payload: unknown): string | null;
}

/**
 * Per-harness knowledge, keyed by HarnessId (config.ts). Operator config
 * keeps only what is genuinely operator-tunable; harness facts live here,
 * versioned with the code that shares their assumptions.
 */
export interface HarnessAdapter {
  /**
   * Env overlay for the spawned harness process: model pinning and quirk
   * workarounds. Keys with `undefined` values override anything inherited
   * from AgentDeck's own environment.
   */
  spawnEnv(model: string): Record<string, string | undefined>;
  /** The harness's Usage Collector; null while it has none (ACP totals only). */
  usage: UsageCollector | null;
}

const unknownAdapter: HarnessAdapter = {
  spawnEnv: () => ({}),
  usage: null,
};

const adapters: Record<string, HarnessAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  copilot: copilotAdapter,
};

export function adapterFor(harnessId: string): HarnessAdapter {
  return adapters[harnessId] ?? unknownAdapter;
}
