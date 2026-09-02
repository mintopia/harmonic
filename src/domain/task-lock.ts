import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-Task in-process serialization (ADR-0020): every Task-mutating operation —
 * accept, requeue, cancel, complete, settle, auto-run claim — runs under a lock
 * keyed by Task id, so a long Accept holds its Task across the whole
 * verify→merge→settle span and no other path can transition that Task
 * underneath it. Distinct Tasks never block each other. Reentrant: a nested
 * `withTaskLock` on a Task the current call stack already holds runs `fn`
 * inline (an Accept that already holds the lock re-enters through `settle` and
 * `setState`). Process-local and rebuilt empty at boot — nothing durable, in
 * line with ADR-0001's in-process-only coordination.
 *
 * Lock ordering: acquire the Task lock BEFORE the repo locks
 * (`withRepoLock`/`withBaseCheckoutLock`) — as Accept does (Task lock, then the
 * merge's repo locks). Boot crash-recovery is the sole path that inverts this
 * (repo locks, then `settle`'s Task lock); it is safe only because it runs to
 * completion before any executor or HTTP handler is live. A new runtime path
 * that calls a Task-locked op while holding a repo lock would risk an AB-BA
 * deadlock against a concurrent Accept.
 */
function keyedMutex<K>(): <T>(key: K, fn: () => Promise<T>) => Promise<T> {
  const chains = new Map<K, Promise<void>>();
  const heldKeys = new AsyncLocalStorage<ReadonlySet<K>>();

  return async function withLock<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const outer = heldKeys.getStore();
    if (outer?.has(key)) return fn();

    const prev = chains.get(key) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => gate);
    chains.set(key, tail);

    await prev.catch(() => {});
    const nested = new Set(outer ?? []);
    nested.add(key);
    try {
      return await heldKeys.run(nested, fn);
    } finally {
      release();
      if (chains.get(key) === tail) chains.delete(key);
    }
  };
}

export const withTaskLock = keyedMutex<number>();
