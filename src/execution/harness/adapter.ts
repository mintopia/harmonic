import type { HarnessId } from '../../config.js';
import type { ParsedSession } from '../usage.js';
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
 * A live, incremental reader of one run's native session log (issue #217).
 * `sample()` folds only the bytes appended since the previous call — off the
 * event loop — instead of the whole-file re-parse `parse()` does every tick,
 * which pinned a core on a long run. `latest()` returns that same folded
 * result with no I/O, for the on-demand readers (Activity snapshot, spend
 * guard) that piggy-back on the tailer's cadence rather than re-parsing
 * themselves. One reader per (run, session); concurrent `sample()`s serialize.
 */
export interface SessionTailReader {
  /** Advance over newly-appended bytes and return the freshest parse; null
   *  until a log exists. Never throws — a mid-write file yields the last good
   *  parse. Concurrent calls are serialized onto one cursor. */
  sample(): Promise<ParsedSession | null>;
  /** The last parse `sample()` produced, with no I/O; null before the first. */
  latest(): ParsedSession | null;
}

/**
 * The per-Harness Usage source (CONTEXT.md: Usage Collector): how to read
 * a per-model breakdown, either straight off the ACP prompt result
 * (codex) or out of the native session log (claude). Aggregate totals
 * come from the generic ACP `usage` path in usage.ts.
 */
export interface UsageCollector {
  /** Discover the actual native transcript a Harness wrote for a Session.
   * Unlike {@link sessionLogFile}, this must not reconstruct a path from cwd. */
  resolveTranscriptPath?(input: { sessionLogDir?: string | undefined; sessionId: string }): Promise<string | null>;
  /**
   * Parse a session's native logs into rolled-up Usage plus its Process
   * Tree (ADR 0009) — the source that replaces the ACP-result/OTel reads
   * below. Optional here so the existing collectors compile unchanged;
   * the per-Harness parsers land in #48 (claude) / #49 (codex, copilot),
   * which then make this the sole path and retire the methods below.
   * Returns null when no log exists yet.
   */
  parse?(input: { sessionLogDir?: string | undefined; cwd: string; sessionId: string | null }): ParsedSession | null;
  /**
   * An incremental, async tailer for this harness's live session log (#217):
   * each tick folds only newly-appended bytes instead of re-reading the whole
   * file synchronously on the event loop. Implemented by the line-log harnesses
   * (claude transcripts, codex rollouts) via a `LineCursor`. Absent → the
   * runner falls back to a whole-file `parse()` per tick (`wholeFileReader`);
   * copilot stays there deliberately (its usage is a bounded, synchronous
   * sqlite query, not an unbounded whole-file re-parse). `sessionId` is non-null
   * here — the reader is created only once a session exists.
   */
  createTailReader?(input: { sessionLogDir?: string | undefined; cwd: string; sessionId: string }): SessionTailReader;
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
   * `sessionId` disambiguates rows shared between runs (copilot's
   * `session-store.db` is a single store keyed by session id); harnesses
   * with per-session files ignore it.
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

/**
 * The fallback tail reader for a collector with no `createTailReader` (codex,
 * copilot): re-run the whole-file `parse()` each `sample()` and cache it for
 * `latest()`. No incremental win, but it keeps every harness on the same async
 * `sample()`/cached-`latest()` contract the runner drives (#217). `parse` here
 * is still synchronous CPU, acceptable for their small logs.
 */
export function wholeFileReader(
  collector: UsageCollector,
  input: { sessionLogDir?: string | undefined; cwd: string; sessionId: string },
): SessionTailReader {
  let cached: ParsedSession | null = null;
  return {
    sample: async () => {
      cached = collector.parse?.(input) ?? null;
      return cached;
    },
    latest: () => cached,
  };
}

/**
 * Monotonic version of the adapter layer's assumptions, bumped when a change to
 * how harnesses are spawned/driven would make a mid-flight Session unsafe to
 * resume. Recorded on every Session (issue #141) as the adapter half of the
 * resume compatibility key; a Session whose stored `adapterVersion` differs
 * from the current one is forced to a fresh Session rather than a `session/load`
 * when resume lands. One global counter (a claude-only change conservatively
 * invalidates all harnesses) — deliberately over-cautious for the foundation.
 */
export const ADAPTER_VERSION = 1;

/** The `adapterVersion` string recorded on a Session: the harness id plus the
 * adapter version, e.g. `claude@1`. */
export function adapterVersion(harnessId: string): string {
  return `${harnessId}@${ADAPTER_VERSION}`;
}
