import { createHash } from 'node:crypto';
import { Git } from './git.js';

/**
 * The frozen candidate snapshot (issue #134, reliability-design Unit B +
 * round-5 refinement #1, locked).
 *
 * When a Run finishes executing it enters `validating`, where Harmonic freezes
 * the agent's work into an immutable **candidate** — a commit built with
 * `commit-tree` and pinned to a **private Harmonic ref** — *without ever moving
 * the intended target branch*. Verification (a later ticket) then runs against
 * this candidate in a **disposable detached worktree**, so a command or critic
 * sees a stable tree it cannot land, and can never sweep the live branch's
 * index/checkout into its verdict.
 *
 * This module is the substrate only: it builds the frozen tree and proves the
 * safety property (target ref untouched; disposable worktree removed after;
 * before/after fingerprints catch a verifier that mutated the tree). No
 * verifier consumes the candidate yet — the `verify` hook is where one will
 * plug in.
 *
 * Pure of the database and the Runner, like `run-phases.ts`: it takes explicit
 * paths/revisions and returns a structured result, so it is exhaustively
 * testable against a throwaway git repo in isolation.
 */

export interface BuildCandidateArgs {
  /** The base repo that owns the object store and refs. */
  repoDir: string;
  /** The leased working tree holding the agent's work to snapshot. */
  workspaceDir: string;
  /** The validated base commit — the candidate's parent and the tree the
   * hermetic `add -A` is measured against. A branch name or `HEAD` is fine;
   * it is resolved to a stable OID so the candidate parent never drifts. */
  baseRev: string;
  /** Private Harmonic ref to pin the candidate to (never the target branch). */
  ref: string;
  /** Commit message for the candidate. */
  message: string;
  /** Overwrite `ref` if it already exists instead of the create-only CAS. A
   * self-heal turn (issue #137) re-snapshots against the SAME
   * `refs/harmonic/candidate/run-<id>` ref, which the first turn already
   * created; without this the create-only pin fails and the heal would verify
   * the stale candidate. Absent/false on a Run's first snapshot. */
  force?: boolean;
}

/**
 * Build the candidate commit hermetically and pin it to its private ref.
 *
 * Recipe (round-5 #1): a private temp index seeded from the validated base →
 * `add -A` from the leased workspace → `write-tree` → `commit-tree` with the
 * validated base as parent → CAS-create the private ref. Every step writes
 * only objects and one private ref; the target branch, the workspace index,
 * and the workspace checkout are all left exactly as they were.
 *
 * @returns the candidate commit OID.
 */
export async function buildCandidate(args: BuildCandidateArgs): Promise<string> {
  const parent = await Git.revParse(args.repoDir, args.baseRev);
  const tree = await Git.writeWorkspaceTree(args.workspaceDir, parent);
  const oid = await Git.commitTree(args.repoDir, tree, parent, args.message);
  if (args.force) {
    await Git.setRef(args.repoDir, args.ref, oid);
  } else {
    await Git.createRef(args.repoDir, args.ref, oid);
  }
  return oid;
}

/**
 * A stable fingerprint of a checkout: the OID of its full working-tree content
 * (tracked + untracked + deletions, via a hermetic `write-tree`) plus a hash of
 * every ref. Any file a verifier mutates changes the tree half; any ref it
 * touches through the shared git dir changes the ref half. Comparing the
 * fingerprint before and after a verifier runs is how tree mutation is caught.
 */
export async function fingerprint(repoDir: string, worktreeDir: string): Promise<string> {
  const tree = await Git.writeWorkspaceTree(worktreeDir, 'HEAD');
  // Hash every ref EXCEPT Harmonic's own `refs/harmonic/*` bookkeeping. Those
  // are created/moved concurrently by other Runs sharing this base repo (each
  // Run pins its own candidate ref), so including them would flip `mutated` for
  // a verifier that touched nothing — a false positive. A real verifier mutates
  // branches/tags, which are still covered.
  const refs = (await Git.forEachRef(repoDir))
    .split('\n')
    .filter((line) => !/ refs\/harmonic\//.test(line))
    .join('\n');
  return `${tree}|${createHash('sha256').update(refs).digest('hex')}`;
}

export interface WorktreeProof<T> {
  /** Fingerprint taken immediately after checkout, before `fn` ran. */
  before: string;
  /** Fingerprint taken immediately after `fn` returned. */
  after: string;
  /** Whether `fn` mutated the tree or a ref (`before !== after`). */
  mutated: boolean;
  /** Whatever `fn` returned. */
  result: T;
}

/**
 * Check `oid` out in a disposable detached worktree at `worktreePath`, run
 * `fn` against it bracketed by before/after fingerprints, then remove the
 * worktree unconditionally (removal-only cleanup — never a commit). The
 * detached HEAD means `fn` sees a stable tree it cannot land.
 */
export async function withDetachedWorktree<T>(
  repoDir: string,
  oid: string,
  worktreePath: string,
  fn: (dir: string) => Promise<T>,
): Promise<WorktreeProof<T>> {
  await Git.addDetachedWorktree(repoDir, worktreePath, oid);
  try {
    const before = await fingerprint(repoDir, worktreePath);
    const result = await fn(worktreePath);
    const after = await fingerprint(repoDir, worktreePath);
    return { before, after, mutated: before !== after, result };
  } finally {
    await Git.removeWorktree(repoDir, worktreePath).catch(() => {});
  }
}

export interface SnapshotCandidateArgs extends BuildCandidateArgs {
  /** `'worktree'` | `'direct'` — a dirty *direct* context is not snapshotted. */
  isolationMode: string;
  /** Whether a direct-mode context was already dirty at Run start. A dirty or
   * concurrently-editable direct context yields no candidate, so unrelated
   * local edits are never swept into verification. */
  startDirty: boolean;
  /** Where to check out the disposable verification worktree. */
  worktreePath: string;
  /** Future verifier hook, run against the detached checkout. #134 passes none
   * (no verifier consumes the candidate yet); it exists so the before/after
   * fingerprint bracket is already in place for the verify unit to plug into. */
  verify?: (dir: string) => Promise<void>;
}

export type CandidateSnapshot =
  | { status: 'skipped'; reason: string }
  | { status: 'created'; oid: string; ref: string; mutated: boolean };

/**
 * Freeze the candidate and prove the safety property, or skip when the context
 * forbids it. Returns a structured outcome the Runner persists + records; it
 * never throws for a skip, only for a genuine git failure.
 */
export async function snapshotCandidate(args: SnapshotCandidateArgs): Promise<CandidateSnapshot> {
  if (args.isolationMode !== 'worktree' && args.startDirty) {
    return { status: 'skipped', reason: 'dirty-direct-context' };
  }
  const oid = await buildCandidate(args);
  const proof = await withDetachedWorktree(
    args.repoDir,
    oid,
    args.worktreePath,
    // No verifier consumes the candidate yet (#134); the hook proves the
    // bracket works and stays a no-op until the verify unit lands.
    async (dir) => {
      await args.verify?.(dir);
    },
  );
  return { status: 'created', oid, ref: args.ref, mutated: proof.mutated };
}
