/** Tracks fire-and-forget background promises so a shutdown can await them before the DB goes away. */
export class InFlight {
  private readonly pending = new Set<Promise<unknown>>();

  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    const forget = (): void => { this.pending.delete(promise); };
    promise.then(forget, forget);
    return promise;
  }

  /** Settles once nothing is pending, including work started by work that was pending. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}
