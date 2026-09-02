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
 * The canonical Work Context identity key — the identity a Work Context's
 * occupancy is tracked against. `direct` mode keys on the canonical Working
 * Directory alone (`branch` is ignored: direct-mode Attempts share one
 * physical checkout). `worktree` mode keys on the canonical worktree path AND
 * the branch, and requires both.
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
