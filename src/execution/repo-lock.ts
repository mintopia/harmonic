import { AsyncLocalStorage } from 'node:async_hooks';
import { repoKey } from '../domain/work-context-key.js';

export { repoKey };

function keyedRepoMutex(): <T>(dir: string, fn: () => Promise<T>) => Promise<T> {
  const chains = new Map<string, Promise<void>>();
  const heldKeys = new AsyncLocalStorage<ReadonlySet<string>>();

  return async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const key = repoKey(dir);
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

/**
 * Run `fn` under a short mutual-exclusion lock scoped to the base repository
 * `dir`: worktree create/remove, branch create/delete, and the brief
 * checkout/merge/commit steps of a base-branch merge. Same-repo operations
 * serialise; distinct repos never block each other. Reentrant: a nested
 * `withRepoLock` on a repo the current call stack already holds runs `fn`
 * inline. It does not span a merge's agentic conflict-resolution turns — see
 * {@link withBaseCheckoutLock}.
 */
export const withRepoLock = keyedRepoMutex();

/**
 * Run `fn` under a lock that serialises operations mutating the shared base
 * checkout's working tree — a base-branch merge (including its agentic
 * conflict-resolution turns), an Epic integration refresh, and crash-recovery's
 * merge-orphan reconciliation. Always acquire this lock BEFORE
 * {@link withRepoLock}.
 */
export const withBaseCheckoutLock = keyedRepoMutex();
