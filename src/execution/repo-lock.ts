import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Canonical identity for a base repository directory, stable across
 * trailing slashes, `.`/`..` segments, and symlinks — so two references to
 * the same physical checkout serialize on the same lock. Falls back to a
 * normalised absolute path when the directory can't be resolved (e.g. it
 * doesn't exist yet or isn't readable).
 */
export function repoKey(dir: string): string {
  try {
    return realpathSync(resolve(dir));
  } catch {
    return resolve(dir);
  }
}

/** One promise chain per base-repo key; the tail is the current holder. */
const chains = new Map<string, Promise<void>>();

/**
 * Run `fn` under a short mutual-exclusion lock scoped to the base
 * repository `dir` (issue #121).
 *
 * The lock protects the risky base-repo mutation windows — worktree
 * create, base-branch merge, worktree remove — so two concurrent
 * worktree Runs can't corrupt the shared base repo while one is
 * mid-mutation. Operations on the *same* base repo serialise; distinct
 * repos never block each other, so Runs on different checkouts keep
 * running in parallel. The lock is held only for the duration of `fn`
 * and released on both success and failure.
 */
export async function withRepoLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = repoKey(dir);
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
  try {
    return await fn();
  } finally {
    release();
    // Drop the entry when we're still the tail so keys don't leak; a newer
    // waiter that chained on after us leaves its own tail in place.
    if (chains.get(key) === tail) chains.delete(key);
  }
}
