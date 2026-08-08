import type { RunUsageSnapshot } from './usage.js';

/** Push cadence (~1s) and persist cadence (~10s) are deliberately decoupled
 * (ADR 0010): a smooth UI stream, a lazy DB write. */
export interface TailerCadence {
  pushMs: number;
  persistMs: number;
}

export interface TailerHooks {
  /** Rebuild the run's snapshot from its native log; null when nothing to read yet. */
  sample: (runId: number) => RunUsageSnapshot | null;
  /** Broadcast the snapshot as a `run_usage` firehose event. */
  emit: (runId: number, snapshot: RunUsageSnapshot) => void;
  /** Overwrite the run row's persisted snapshot. */
  persist: (runId: number, snapshot: RunUsageSnapshot) => void;
}

interface Tail {
  timer: ReturnType<typeof setInterval>;
  /** Serialized last-pushed snapshot; skips emitting an unchanged one. */
  lastPushed: string | null;
  lastPersistAt: number;
}

/**
 * Tails each active Run's native log (ADR 0010). On a ~1s interval it
 * re-samples the snapshot and pushes it — sampling at a fixed cadence *is*
 * the coalescing, so a chatty log can never saturate the socket. It persists
 * on a coarser ~10s cadence, and flushes (emit + persist) once more on stop,
 * so a Run always ends with its final snapshot on the row.
 */
export class LiveUsageTailer {
  private tails = new Map<number, Tail>();

  constructor(
    private readonly hooks: TailerHooks,
    private readonly cadence: TailerCadence = { pushMs: 1000, persistMs: 10_000 },
  ) {}

  start(runId: number): void {
    if (this.tails.has(runId)) return;
    const timer = setInterval(() => this.tick(runId), this.cadence.pushMs);
    // Never keep the process alive for a usage sampler.
    timer.unref?.();
    this.tails.set(runId, { timer, lastPushed: null, lastPersistAt: Date.now() });
  }

  /** Final flush + teardown: emit and persist the last snapshot unconditionally. */
  stop(runId: number): void {
    const tail = this.tails.get(runId);
    if (!tail) return;
    clearInterval(tail.timer);
    this.tails.delete(runId);
    const snapshot = this.hooks.sample(runId);
    if (snapshot) {
      this.hooks.emit(runId, snapshot);
      this.hooks.persist(runId, snapshot);
    }
  }

  private tick(runId: number): void {
    const tail = this.tails.get(runId);
    if (!tail) return;
    const snapshot = this.hooks.sample(runId);
    if (!snapshot) return;
    const serialized = JSON.stringify(snapshot);
    if (serialized !== tail.lastPushed) {
      tail.lastPushed = serialized;
      this.hooks.emit(runId, snapshot);
    }
    const now = Date.now();
    if (now - tail.lastPersistAt >= this.cadence.persistMs) {
      tail.lastPersistAt = now;
      this.hooks.persist(runId, snapshot);
    }
  }
}
