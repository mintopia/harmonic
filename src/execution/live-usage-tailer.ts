import type { AttemptUsageSnapshot } from './usage.js';

/** Push cadence (~1s) and persist cadence (~10s) are decoupled: a smooth UI
 * stream, a lazy DB write. */
export interface TailerCadence {
  pushMs: number;
  persistMs: number;
}

export interface TailerHooks {
  /** Advance the run's incremental reader and return its freshest snapshot;
   *  null when nothing to read yet. */
  sample: (runId: number) => Promise<AttemptUsageSnapshot | null>;
  /** Broadcast the snapshot as a `attempt_usage` firehose event. */
  emit: (runId: number, snapshot: AttemptUsageSnapshot) => void;
  /** Overwrite the run row's persisted snapshot. */
  persist: (runId: number, snapshot: AttemptUsageSnapshot) => void;
}

interface Tail {
  timer: ReturnType<typeof setInterval>;
  lastPushed: string | null;
  lastPersistAt: number;
  sampling: boolean;
}

/**
 * Tails each active Run's native log. On a ~1s interval it re-samples the
 * snapshot and pushes it — sampling at a fixed cadence *is* the coalescing, so
 * a chatty log can never saturate the socket. It persists on a coarser ~10s
 * cadence, and flushes (emit + persist) once more on stop, so a Run always
 * ends with its final snapshot on the row.
 */
export class LiveUsageTailer {
  private tails = new Map<number, Tail>();

  constructor(
    private readonly hooks: TailerHooks,
    private readonly cadence: TailerCadence = { pushMs: 1000, persistMs: 10_000 },
  ) {}

  start(runId: number): void {
    if (this.tails.has(runId)) return;
    const timer = setInterval(() => void this.tick(runId), this.cadence.pushMs);
    timer.unref?.();
    this.tails.set(runId, { timer, lastPushed: null, lastPersistAt: Date.now(), sampling: false });
  }

  /** Final flush + teardown: emit and persist the last snapshot unconditionally. */
  async stop(runId: number): Promise<void> {
    const tail = this.tails.get(runId);
    if (!tail) return;
    clearInterval(tail.timer);
    this.tails.delete(runId);
    const snapshot = await this.hooks.sample(runId);
    if (snapshot) {
      this.hooks.emit(runId, snapshot);
      this.hooks.persist(runId, snapshot);
    }
  }

  private async tick(runId: number): Promise<void> {
    const tail = this.tails.get(runId);
    if (!tail || tail.sampling) return;
    tail.sampling = true;
    try {
      const snapshot = await this.hooks.sample(runId);
      const live = this.tails.get(runId);
      if (!live || !snapshot) return;
      const serialized = JSON.stringify(snapshot);
      if (serialized !== live.lastPushed) {
        live.lastPushed = serialized;
        this.hooks.emit(runId, snapshot);
      }
      const now = Date.now();
      if (now - live.lastPersistAt >= this.cadence.persistMs) {
        live.lastPersistAt = now;
        this.hooks.persist(runId, snapshot);
      }
    } finally {
      tail.sampling = false;
    }
  }
}
