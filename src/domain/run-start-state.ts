/**
 * Run start-state + admission gate (issue #149, reliability-design Unit D,
 * ADR-0023). When an afk **direct** Run is admitted, Harmonic records the exact
 * starting state as a `run-start-state` `run_fact` so a later unit can tell
 * whether the agent violated the branch contract ("Harmonic owns branching"),
 * and rejects a context it cannot safely track.
 *
 * This module is the **pure** half: the admission decision and the start-state
 * shape, with no git I/O and no database — the same seam as `run-disposition.ts`,
 * so the gate can be exhaustively unit-tested from a plain probe object. The
 * Runner gathers the probe via `Git.*` (execution/git.ts), and on a clean
 * verdict persists `startState` through `RunFactStore` (domain/run-facts.ts).
 */

/**
 * Canonical identity of the repo a direct Run runs against — enough to tell at
 * settle that the same physical repo is still being tracked. The absolute root
 * is the stable identity; the `origin` URL is advisory (a repo may have none).
 */
export interface RepoIdentity {
  /** `git rev-parse --show-toplevel` — the absolute repo root. */
  root: string;
  /** `origin` remote URL when one is configured, else null. */
  remote: string | null;
}

/**
 * The git facts the admission gate needs, gathered by the Runner and passed in
 * so the decision itself touches no git. `branch` is the **symbolic** branch
 * (`symbolic-ref`), or null on a detached HEAD; it is NEVER the literal string
 * `HEAD` — issue #149 requires `HEAD` never be mis-recorded as an ordinary
 * branch.
 */
export interface StartStateProbe {
  repoIdentity: RepoIdentity;
  /** The commit HEAD points at — recorded even when detached. */
  headOid: string;
  /** Symbolic branch name, or null on a detached HEAD. Never `HEAD`. */
  branch: string | null;
  /** `git status --porcelain` non-empty. */
  dirty: boolean;
  /** Stable fingerprint of the working-tree state (sha256 of porcelain). */
  dirtyFingerprint: string;
  /** A tracked gitlink or a `.gitmodules` — recursive submodule state. */
  submodules: boolean;
  /** An independent git repo checked out inside the tree (not a submodule). */
  nestedRepos: boolean;
  /** The expected worktree path (the direct Run's working directory). */
  worktreePath: string;
}

/** The start-state recorded as the `run-start-state` fact's payload. */
export interface RunStartState {
  repoIdentity: RepoIdentity;
  /**
   * The branch the Run started on — the symbolic branch, or the
   * operator-selected landing branch when starting from a detached HEAD. Never
   * `HEAD`.
   */
  startBranch: string;
  /**
   * The commit the Run started at — recorded even when detached, so the
   * candidate parents on it and a later branch-contract check can compare.
   */
  startCommit: string;
  worktreePath: string;
  dirtyFingerprint: string;
  /**
   * Present only when a detached HEAD was admitted onto an operator-selected
   * landing branch.
   */
  landingBranch?: string;
}

export type AdmissionResult =
  | { ok: true; startState: RunStartState }
  | { ok: false; reason: string };

/**
 * Thrown by the Runner when the admission gate rejects an afk-direct context.
 * The Runner catches it around `prepareWorkspace` and routes it to
 * `settleEscalated` (an operator-legible escalate), distinct from a generic
 * execution `failed`.
 */
export class AdmissionRejected extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'AdmissionRejected';
  }
}

/**
 * The pure admission decision for an afk **direct** Run (issue #149,
 * reliability-design Unit D). Rejects a context Harmonic cannot safely own:
 *
 *  - **submodules / nested repositories** — recursive git state Harmonic does
 *    not track and cannot attribute;
 *  - a **dirty** working tree — uncommitted work would be attributed to the Run
 *    that did not produce it, and the branch-contract check could not tell them
 *    apart;
 *  - a **detached HEAD** — there is no branch to land onto, *unless* an
 *    operator-selected `landingBranch` is supplied, in which case the Run is
 *    admitted and the landing branch (never `HEAD`) is recorded as the start
 *    branch.
 *
 * Order matters only for which reason surfaces: a nested repository appears to
 * the outer repo as an untracked directory (so it is *also* dirty), so it is
 * checked before dirty to yield its specific, more actionable reason.
 *
 * On admission it returns the `startState` to persist as the `run-start-state`
 * fact. Total and side-effect free: the same probe always yields the same
 * verdict.
 */
export function evaluateAdmission(probe: StartStateProbe, landingBranch?: string): AdmissionResult {
  if (probe.submodules) {
    return {
      ok: false,
      reason:
        'context contains git submodules; recursive submodule state is unsupported for an afk direct Run',
    };
  }
  if (probe.nestedRepos) {
    return {
      ok: false,
      reason:
        'context contains a nested git repository; nested-repo state is unsupported for an afk direct Run',
    };
  }
  if (probe.dirty) {
    return {
      ok: false,
      reason:
        'context has uncommitted changes (dirty working tree); an afk direct Run requires a clean context so Harmonic can attribute the branch it produces',
    };
  }

  let startBranch: string;
  let landing: string | undefined;
  if (probe.branch === null) {
    // Detached HEAD: admissible only with an operator-selected landing branch.
    if (!landingBranch) {
      return {
        ok: false,
        reason:
          'context is on a detached HEAD with no landing branch; supply an operator-selected landing branch to admit an afk direct Run',
      };
    }
    startBranch = landingBranch;
    landing = landingBranch;
  } else {
    // On a real branch, that branch is the landing target; any supplied
    // landingBranch is ignored (it exists to rescue a detached HEAD).
    startBranch = probe.branch;
  }

  const startState: RunStartState = {
    repoIdentity: probe.repoIdentity,
    startBranch,
    startCommit: probe.headOid,
    worktreePath: probe.worktreePath,
    dirtyFingerprint: probe.dirtyFingerprint,
    ...(landing ? { landingBranch: landing } : {}),
  };
  return { ok: true, startState };
}
