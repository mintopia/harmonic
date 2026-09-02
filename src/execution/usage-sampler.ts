import { wholeFileReader, type SessionTailReader } from './harness/adapter.js';
import { adapterFor } from './harness/registry.js';
import {
  agentsFromTree,
  collectUsageWithRetry,
  type AttemptUsage,
  type AttemptUsageSnapshot,
  type ParsedSession,
} from './usage.js';
import type { HarnessConfig } from '../config.js';
import type { AttemptStore } from '../domain/attempts.js';

/** The active-run facts the sampler needs to open and decorate a snapshot. */
export interface ActiveAttemptView {
  harnessId: string;
  harness: HarnessConfig;
  cwd: string;
  activity: string | null;
}

/**
 * Owns the live-usage read path: one incremental session-log reader per active
 * Attempt, advanced by the tailer tick, plus the decoration (tool tally,
 * per-agent breakdown, activity line) that turns a raw parse into an
 * {@link AttemptUsageSnapshot}. Also collects the settle-time Usage. Every path
 * here is best-effort and never fails the Attempt.
 */
export class UsageSampler {
  private readonly readers = new Map<number, SessionTailReader>();

  constructor(
    private readonly attempts: Pick<AttemptStore, 'get' | 'listToolCalls'>,
    private readonly getActive: (attemptId: number) => ActiveAttemptView | undefined,
    /** Bounded per-Attempt ACP tool-call rollups, owned by the drive loop. */
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
   * The live snapshot for a run's tailer: advance the incremental reader and
   * decorate its parse with the tool tally + activity line. Called only by the
   * tailer tick; the on-demand callers read {@link latestSnapshot}.
   */
  async sampleSnapshot(attemptId: number): Promise<AttemptUsageSnapshot | null> {
    const reader = await this.readerFor(attemptId);
    if (!reader) return null;
    return await this.decorateSnapshot(attemptId, await reader.sample());
  }

  /**
   * The freshest snapshot the tailer has already sampled, with no I/O. null
   * before the tailer's first sample.
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
      return {
        ...usage,
        toolCalls: Object.fromEntries(await this.toolCallsFor(input.attemptId)),
      };
    } catch {
      return null;
    }
  }

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

  private async decorateSnapshot(attemptId: number, parsed: ParsedSession | null): Promise<AttemptUsageSnapshot | null> {
    if (!parsed) return null;
    const active = this.getActive(attemptId);
    const toolCalls = Object.fromEntries(await this.toolCallsFor(attemptId));
    const agents = agentsFromTree(parsed.tree);
    const usage: AttemptUsage = { ...parsed.usage, toolCalls, ...(Object.keys(agents).length > 0 ? { agents } : {}) };
    return { usage, contextTokens: parsed.tree.contextTokens, activity: active?.activity ?? null, tree: parsed.tree };
  }
}
