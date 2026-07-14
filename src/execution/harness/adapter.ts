import type { HarnessId } from '../../config.js';
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
 * The per-Harness Usage source (CONTEXT.md: Usage Collector): how to read
 * a per-model breakdown, either straight off the ACP prompt result
 * (codex) or out of the native session log (claude). Aggregate totals
 * come from the generic ACP `usage` path in usage.ts.
 */
export interface UsageCollector {
  /**
   * Per-model usage read straight off the ACP prompt result, when the
   * harness reports it there (codex: `_meta.quota.model_usage`). Absent
   * or empty defers to the session log.
   */
  modelsFromPromptResult?(result: { usage?: Record<string, unknown>; _meta?: unknown }): Record<string, ModelUsage>;
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
  /**
   * ACP `session/new` mcpServers entries granting the agent AgentDeck's
   * MCP server under its Run Key; [] when the harness only gets the
   * env-var mechanism (AGENTDECK_MCP_URL / AGENTDECK_API_KEY).
   */
  mcpServers(input: { url: string; token: string }): unknown[];
  /** The harness's Usage Collector; null while it has none (ACP totals only). */
  usage: UsageCollector | null;
}

const unknownAdapter: HarnessAdapter = {
  spawnEnv: () => ({}),
  mcpServers: () => [],
  usage: null,
};

const adapters: Record<HarnessId, HarnessAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  copilot: copilotAdapter,
};

/** Lookup takes the untyped harness id off a TaskRow; unknown ids get a no-op adapter. */
export function adapterFor(harnessId: string): HarnessAdapter {
  return (adapters as Record<string, HarnessAdapter>)[harnessId] ?? unknownAdapter;
}
