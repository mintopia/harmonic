import { logger } from '../logger.js';

/** Tracks fire-and-forget background promises so a shutdown can await them before the DB goes away. */
export class InFlight {
  private readonly pending = new Set<Promise<unknown>>();

  /** Track `promise` and hand it back; the caller owns its rejection. */
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    const forget = (): void => { this.pending.delete(promise); };
    promise.then(forget, forget);
    return promise;
  }

  /** Track `promise` as background work nobody awaits; an unexpected rejection is logged under `op`. */
  add(promise: Promise<unknown>, op: string): void {
    this.track(promise).catch((error: unknown) => {
      logger.error(`${op} failed`, { op, error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Settles once nothing is pending, including work started by work that was pending. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}
