/**
 * Coalescing single-flight for self-triggering background loops (issue #219).
 *
 * Harmonic's reconcile/retry loops run on the single Node event loop and spawn
 * git subprocesses. When such a loop is re-triggered faster than one pass
 * completes — a burst of `attempt_changed` events firing the session-retirement
 * drain, or a poll timer ticking while a slow scan is still in flight — the
 * naive `void loop()` fan-out stacks overlapping passes. Each overlapping pass
 * re-observes the same not-yet-finished work and re-spawns git for it, turning a
 * burst into a subprocess flood that starves the loop (the #199/#218 failure
 * class, generalised).
 *
 * {@link singleFlight} wraps such a loop so it runs at most once at a time.
 * A call that arrives while a pass is in flight does not start a second pass; it
 * schedules exactly one rerun to fire after the current pass finishes, so work
 * that merged mid-pass is still picked up — coalescing any number of overlapping
 * triggers into a single trailing pass. Every caller waiting during an in-flight
 * window resolves with that final pass's result.
 *
 * This is the same do/while `filling`/`refill` coalescing the Auto-Runner already
 * does inline, lifted into a reusable primitive so every git-spawning loop can
 * adopt it uniformly.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  let again = false;

  const cycle = async (): Promise<T> => {
    try {
      let result: T;
      do {
        // Reset before each pass so triggers that arrive *during* this pass
        // schedule the next one; triggers that arrived earlier are consumed.
        again = false;
        result = await run();
      } while (again);
      return result;
    } finally {
      inFlight = null;
    }
  };

  return (): Promise<T> => {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = cycle();
    return inFlight;
  };
}
