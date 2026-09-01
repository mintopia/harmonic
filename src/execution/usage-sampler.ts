import { adapterFor, wholeFileReader, type SessionTailReader } from './harness/adapter.js';
import {
  agentsFromTree,
  collectUsageWithRetry,
  type AttemptUsage,
  type AttemptUsageSnapshot,
  type ParsedSession,
} from './usage.js';
import type { HarnessConfig } from '../config.js';
import type { AttemptStore } from '../domain/attempts.js';

/** The active-run facts the sampler needs to open and decorate a snapshot: the
 * harness identity/config + working dir locate the native session log, and the
 * live activity line rides on the decorated snapshot. */
export interface ActiveAttemptView {
  harnessId: string;
  harness: HarnessConfig;
  cwd: string;
  activity: string | null;
}

/**
 * Owns the live-usage read path (ADR 0010, #217): one incremental session-log
 * reader per active Attempt, advanced by the tailer tick, plus the decoration
 * (tool tally, per-agent breakdown, activity line) that turns a raw parse into
 * an {@link AttemptUsageSnapshot}. Also collects the settle-time Usage. Live
 * usage is decoration on a Run — every path here is best-effort and never fails
 * the Run.
 */
export class UsageSampler {
  /** One incremental session-log reader per active Attempt (#217): the tailer
   *  tick advances it off the event loop; the Activity snapshot and spend guard
   *  read its cached `latest()`. Created lazily once a session id exists, dropped
   *  on `tailer.stop`. */
  private readonly readers = new Map<number, SessionTailReader>();

  constructor(
    private readonly attempts: Pick<AttemptStore, 'get' | 'listToolCalls'>,
    private readonly getActive: (attemptId: number) => ActiveAttemptView | undefined,
    /** Bounded per-Run ACP tool-call rollups, retained across corrective turns —
     * owned by the drive loop, read here for the live "· N tools" figure. */
    private readonly toolCallTotals: ReadonlyMap<number, Map<string, number>>,
  ) {}

  /** Drop a finished Attempt's reader (its `tailer.stop` counterpart). */
  dropReader(attemptId: number): void {
    this.readers.delete(attemptId);
  }

  /** Drop every reader (process shutdown). */
  clearReaders(): void {
    this.readers.clear();
  }

  /**
   * The live snapshot for a run's tailer (ADR 0010): advance the incremental
   * reader (#217 — off the event loop, only newly-appended bytes) and decorate
   * its parse with the event-derived tool tally + activity line. Called only by
   * the tailer tick; the on-demand callers read {@link latestSnapshot}.
   */
  async sampleSnapshot(attemptId: number): Promise<AttemptUsageSnapshot | null> {
    const reader = await this.readerFor(attemptId);
    if (!reader) return null;
    return await this.decorateSnapshot(attemptId, await reader.sample());
  }

  /**
   * The freshest snapshot the tailer has already sampled, with no I/O — for the
   * on-demand callers (Activity snapshot #51, spend guard #128) that ride the
   * tailer's ~1s cadence instead of re-parsing the whole log themselves (#217).
   * null before the tailer's first sample.
   */
  async latestSnapshot(attemptId: number): Promise<AttemptUsageSnapshot | null> {
    return await this.decorateSnapshot(attemptId, this.readers.get(attemptId)?.latest() ?? null);
  }

  /** The live tool-call rollup for `attemptId`: the in-memory cache while a
   * `driveOnce` owns it, else the persisted Attempt-keyed snapshot. */
  async toolCallsFor(attemptId: number): Promise<Map<string, number>> {
    const cached = this.toolCallTotals.get(attemptId);
    if (cached) return cached;
    return this.attempts.listToolCalls(attemptId);
  }

  /** Usage is decoration on a finished run — never let it fail the run. */
  async collectUsageSafe(input: {
    harnessId: string;
    harness: HarnessConfig;
    cwd: string;
    attemptId: number;
    promptResult: { stopReason?: string; usage?: Record<string, unknown>; _meta?: unknown } | undefined;
  }): Promise<AttemptUsage | null> {
    try {
      const usage = await collectUsageWithRetry({
        harnessId: input.harnessId,
        harness: input.harness,
        cwd: input.cwd,
        sessionId: (await this.attempts.get(input.attemptId)).sessionId,
        promptResult: input.promptResult,
      });
      if (!usage) return null;
      // `usage.contextTokens` is the parsed tree's last-turn footprint (see
      // collectUsage) — the true window fill; never re-derive it from the ACP
      // aggregate here (that sums every round-trip and reads past the window).
      return {
        ...usage,
        toolCalls: Object.fromEntries(await this.toolCallsFor(input.attemptId)),
      };
    } catch {
      return null;
    }
  }

  /**
   * The run's incremental session-log reader (#217), created lazily once a
   * session id exists. claude tails only newly-appended bytes each tick; the
   * other harnesses fall back to a whole-file `parse()` per tick
   * (`wholeFileReader`). null before a session id, or for a harness with no
   * Usage Collector. Reused across ticks so the byte cursor persists.
   */
  private async readerFor(attemptId: number): Promise<SessionTailReader | null> {
    const existing = this.readers.get(attemptId);
    if (existing) return existing;
    const active = this.getActive(attemptId);
    if (!active) return null;
    const sessionId = (await this.attempts.get(attemptId)).sessionId;
    if (!sessionId) return null;
    const collector = adapterFor(active.harnessId).usage;
    if (!collector) return null;
    const input = { sessionLogDir: active.harness.sessionLogDir, cwd: active.cwd, sessionId };
    const reader = collector.createTailReader?.(input) ?? wholeFileReader(collector, input);
    this.readers.set(attemptId, reader);
    return reader;
  }

  /**
   * `parse`/the reader yield the per-model roll-up and tree but no tool tally
   * (computed from the in-memory ACP rollup) — so the live "· N tools" figure the Board
   * ticks off `attempt_usage` (issue #100) would be stuck at zero. Tally the run's
   * rollup here, and fold the per-agent breakdown in for parity with the
   * settle-time Usage. The current-activity line comes off the active Run.
   */
  private async decorateSnapshot(attemptId: number, parsed: ParsedSession | null): Promise<AttemptUsageSnapshot | null> {
    if (!parsed) return null;
    const active = this.getActive(attemptId);
    const toolCalls = Object.fromEntries(await this.toolCallsFor(attemptId));
    const agents = agentsFromTree(parsed.tree);
    const usage: AttemptUsage = { ...parsed.usage, toolCalls, ...(Object.keys(agents).length > 0 ? { agents } : {}) };
    return { usage, contextTokens: parsed.tree.contextTokens, activity: active?.activity ?? null, tree: parsed.tree };
  }
}
