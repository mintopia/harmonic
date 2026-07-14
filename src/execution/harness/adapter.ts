import type { HarnessId } from '../../config.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { copilotAdapter } from './copilot.js';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Harness-native spend units for this model's calls (Copilot AI Units,
   * CONTEXT.md) — actual spend shown alongside Cost, never folded into it
   * (decision Q4). Absent when the harness has none; never a fake zero.
   */
  aiUnits?: number;
}

/** The per-run inputs a harness may need to build its spawn environment. */
export interface SpawnInput {
  model: string;
  /** The directory the run executes in (worktree path in worktree mode). */
  cwd: string;
  /** Operator override for the harness's session-log root (config). */
  sessionLogDir?: string | undefined;
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
  /**
   * Per-model token usage parsed from the session log at `file`.
   * `sessionId` disambiguates logs shared between runs (copilot's OTel
   * file is keyed by cwd, so direct-mode runs of one directory share it);
   * harnesses with per-session files ignore it.
   */
  modelsFromSessionLog(file: string, sessionId?: string | null): Record<string, ModelUsage>;
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
   * from Harmonic's own environment.
   */
  spawnEnv(input: SpawnInput): Record<string, string | undefined>;
  /**
   * ACP modelId to pin via `session/set_model` immediately after
   * `session/new`, for harnesses with no reliable spawn-time pin
   * (copilot). Absent when spawnEnv carries the pin instead.
   */
  sessionModelId?(model: string): string;
  /**
   * ACP `session/new` mcpServers entries granting the agent Harmonic's
   * MCP server under its Run Key; [] when the harness only gets the
   * env-var mechanism (HARMONIC_MCP_URL / HARMONIC_API_KEY).
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
