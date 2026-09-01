import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IsolationMode } from '../config.js';
import { DomainError } from './errors.js';

export interface WorkContextKeyInput {
  isolationMode: IsolationMode;
  workingDir: string;
  worktreePath?: string;
  branch?: string;
}

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

/**
 * The canonical Work Context identity key (ADR-0001,
 * reliability-design §0.5): the identity a Work Context's occupancy is tracked
 * against. Pure and side-effect free; reuses `repoKey` (defined below,
 * issue #121) for path canonicalisation rather than re-deriving it, so the
 * occupancy key and the base-repo lock key agree on what "the same directory"
 * means (trailing slashes, `.`/`..` segments, symlinks all collapse).
 *
 * The two Isolation Modes are deliberately asymmetric (ADR-0001
 * "Reconciliation"):
 *
 * - `direct` mode keys on the canonical Working Directory identity ALONE —
 *   `branch` is ignored. Direct-mode Runs share one physical checkout and
 *   its one checked-out branch, so two Runs against the same directory on
 *   *different* branches are still contending for the same physical
 *   occupancy; collapsing them onto a single key is what lets the scheduler
 *   predicate detect occupancy rather than missing it because the branch strings
 *   happened to differ.
 * - `worktree` mode keys on the canonical *worktree* path AND the branch.
 *   The builder worktree is per-Task (ADR-0046): the Runner derives a
 *   per-Task path `task-<id>` and branch `harmonic/task-<id>`, reused by every
 *   Attempt. Distinct Tasks get distinct keys by construction, so worktree Runs
 *   off the same base repo are genuinely isolated. Only ever one Run of a Task
 *   is active at a time, so the shared per-Task key never double-admits; the
 *   `branch` component keeps the identity meaningful and pairs with the path.
 *
 * `worktree` mode requires both `worktreePath` and `branch` — a key that
 * silently dropped either would under-scope the key, so both are validated
 * rather than defaulted.
 */
export function workContextKey(input: WorkContextKeyInput): string {
  if (input.isolationMode === 'direct') {
    return `direct:${repoKey(input.workingDir)}`;
  }
  if (!input.worktreePath || !input.branch) {
    throw new DomainError(
      'validation',
      'worktree mode requires both worktreePath and branch to derive a Work Context key',
    );
  }
  return `worktree:${repoKey(input.worktreePath)}::${input.branch}`;
}
