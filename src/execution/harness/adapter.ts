import type { ModelUsage } from '../../domain/usage.js';
import type { ParsedSession } from '../usage.js';
import type { TranscriptLogEvent } from './transcript.js';

export type { ModelUsage };

/** The per-run inputs a harness may need to build its spawn environment. */
export interface SpawnInput {
  model: string;
  /** The directory the run executes in (worktree path in worktree mode). */
  cwd: string;
  /** Operator override for the harness's session-log root (config). */
  sessionLogDir?: string | undefined;
}

/**
 * A live, incremental reader of one run's native session log. `sample()`
 * folds only the bytes appended since the previous call; `latest()` returns
 * that same folded result with no I/O. One reader per (run, session);
 * concurrent `sample()`s serialize.
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
 * The per-Harness Usage source: how to read a per-model breakdown, either
 * straight off the ACP prompt result (codex) or out of the native session
 * log (claude). Aggregate totals come from the generic ACP `usage` path.
 */
export interface UsageCollector {
  /** Discover the actual native transcript a Harness wrote for a Session.
   * Unlike {@link sessionLogFile}, this must not reconstruct a path from cwd. */
  resolveTranscriptPath?(input: { sessionLogDir?: string | undefined; sessionId: string }): Promise<string | null>;
  /**
   * Parse a session's native logs into rolled-up Usage plus its Process
   * Tree. Returns null when no log exists yet.
   */
  parse?(input: { sessionLogDir?: string | undefined; cwd: string; sessionId: string | null }): ParsedSession | null;
  /**
   * An incremental, async tailer for this harness's live session log. Absent
   * means the runner falls back to a whole-file `parse()` per tick
   * (`wholeFileReader`). `sessionId` is non-null here: the reader is created
   * only once a session exists.
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

export interface TranscriptCollector {
  events(entry: unknown, firstId: number, parentToolUseId?: string): TranscriptLogEvent[];
  isDuplicateMessage?(entry: unknown, previousEntry: unknown): boolean;
  subagents?(rootPath: string): Promise<Array<{ path: string; parentToolUseId: string }>>;
}

/** Per-harness knowledge, keyed by HarnessId. */
export interface HarnessAdapter {
  /** Prefix used when this harness invokes one of Harmonic's prompt skills. */
  commandPrefix: '$' | '/';
  /** Native transcript parser and optional related transcript discovery. */
  transcript: TranscriptCollector | null;
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
   * MCP server under its Attempt Key; [] when the harness only gets the
   * env-var mechanism (HARMONIC_MCP_URL / HARMONIC_API_KEY).
   */
  mcpServers(input: { url: string; token: string }): unknown[];
  /** Selects this harness's unattended ACP permission mode, if it advertises one. */
  unattendedPermissionMode(available: readonly string[]): string | undefined;
  /** Whether a missing unattended mode must stop an autonomous turn. */
  requiresUnattendedPermissionMode: boolean;
  /** The harness's Usage Collector; null while it has none (ACP totals only). */
  usage: UsageCollector | null;
}

/**
 * The fallback tail reader for a collector with no `createTailReader`: re-run
 * the whole-file `parse()` each `sample()` and cache it for `latest()`.
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
