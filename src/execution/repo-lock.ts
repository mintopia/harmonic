import { AsyncLocalStorage } from 'node:async_hooks';
import { repoKey } from '../domain/work-context-key.js';

export { repoKey };

/**
 * A reentrant, per-`dir` mutual-exclusion lock. Each factory instance owns its
 * own promise-chain map and held-key store, so two instances keyed on the same
 * physical `dir` form independent lock domains that never contend with each
 * other — only with themselves.
 */
function keyedRepoMutex(): <T>(dir: string, fn: () => Promise<T>) => Promise<T> {
  // One promise chain per repo key; the tail is the current holder.
  const chains = new Map<string, Promise<void>>();
  // The set of repo keys the current async call stack already holds. A nested
  // acquisition of a key already in this set runs inline (reentrant) instead of
  // chaining behind itself and deadlocking.
  const heldKeys = new AsyncLocalStorage<ReadonlySet<string>>();

  return async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const key = repoKey(dir);
    const outer = heldKeys.getStore();
    if (outer?.has(key)) return fn();

    // Our turn begins once the previous holder settles (ignore its outcome).
    const prev = chains.get(key) ?? Promise.resolve();

    // A gate the next waiter blocks on until our critical section completes.
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
      // Drop the entry when we're still the tail so keys don't leak; a newer
      // waiter that chained on after us leaves its own tail in place.
      if (chains.get(key) === tail) chains.delete(key);
    }
  };
}

/**
 * Run `fn` under a short mutual-exclusion lock scoped to the base
 * repository `dir` (issue #121).
 *
 * The lock protects the risky base-repo *metadata* mutation windows —
 * worktree create, worktree remove, branch create/delete, and the brief
 * `git checkout`/`git merge`/`git commit` steps of a base-branch merge — so
 * two concurrent worktree Runs can't corrupt the shared base repo while one is
 * mid-mutation. Operations on the *same* base repo serialise; distinct
 * repos never block each other, so Runs on different checkouts keep
 * running in parallel. The lock is held only for the duration of `fn`
 * and released on both success and failure.
 *
 * It deliberately does NOT span a merge's slow agentic conflict-resolution
 * turns: the one merge policy (ADR-0001, issue #455) holds
 * {@link withBaseCheckoutLock} across the whole merge but drops this lock
 * around each resolve turn, so sibling tasks can still create/remove worktrees
 * while a conflict is being resolved in place.
 *
 * **Reentrant**: a nested `withRepoLock` on a repo the current call stack
 * already holds runs `fn` inline rather than waiting on itself. Without this a
 * critical section that must call a locked git primitive under the held lock —
 * e.g. the one merge policy (ADR-0001) running its post-merge check, whose
 * verifier adds a detached worktree ({@link Git.addDetachedWorktree}, itself
 * locked) — would deadlock on a non-reentrant mutex. Reentrancy can only
 * resolve such self-deadlocks: any caller re-locking the same repo under a held
 * lock already hangs today, so none can depend on the blocking behaviour.
 */
export const withRepoLock = keyedRepoMutex();

/**
 * Run `fn` under a lock that serialises operations mutating the shared base
 * checkout's WORKING TREE — a base-branch merge (including its bounded agentic
 * conflict-resolution turns), an Epic integration refresh, and crash-recovery's
 * merge-orphan reconciliation (ADR-0001, issue #455).
 *
 * Distinct from {@link withRepoLock}: the merge policy holds this lock for the
 * whole merge so no sibling merge/refresh/reconcile races the in-progress
 * conflicted tree (`MERGE_HEAD` + conflict markers are real working-tree state),
 * while it drops the metadata `withRepoLock` around each slow resolve turn so
 * worktree create/remove keep flowing. To avoid deadlock, always acquire this
 * lock BEFORE {@link withRepoLock}; metadata-only callers take `withRepoLock`
 * alone and never this one, so no lock-ordering cycle exists.
 */
export const withBaseCheckoutLock = keyedRepoMutex();
