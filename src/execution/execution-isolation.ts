import { Git } from './git.js';

/**
 * Direct-mode execution isolation (issue #152, reliability-design Unit D,
 * ADR-0023, locked).
 *
 * Contract: **Harmonic owns branching.** An afk **direct** Run executes in the
 * operator's live checkout — there is no separate worktree — so an agent's
 * stray `git commit` / `reset` / `checkout -B` on the live branch would expose
 * unverified work on the target the moment it runs. This module closes that
 * hole *without* trying to police the agent:
 *
 *  - **At start** the Run's HEAD is **detached** at the recorded start commit
 *    (issue #149). While detached, every commit the agent makes moves only
 *    HEAD; the live target branch ref is **parked** and cannot advance — the
 *    safety property, independent of what the agent does.
 *  - **At settle** the agent's final commit chain is pinned to a **private
 *    Harmonic ref** (`refs/harmonic/direct/run-<id>`, owned + attributed, and
 *    auto-excluded from the candidate fingerprint), then the live target
 *    checkout is **restored coherently** — HEAD re-attached to the start branch
 *    (which never moved) and the agent's tracked + untracked changes swept, all
 *    already captured hermetically in the candidate (issue #134).
 *  - A frozen candidate is **rematerialisable** into a checkout for a corrective
 *    / review-reject continuation turn.
 *
 * Pure of the database and the Runner, like `candidate.ts` / `run-phases.ts`:
 * it takes explicit paths/revisions and calls only `Git.*`, so it is
 * exhaustively testable against a throwaway git repo in isolation. The Runner
 * wires `detach` into `prepareWorkspace` (after admission records the
 * start-state) and `capture`+`restore` into `finalizeWorkspace` (before the
 * lease is released at settle).
 */

/**
 * The private Harmonic ref a direct Run's agent commits are pinned to. Keyed on
 * the globally-unique run id and living under `refs/harmonic/*`, so it (a) never
 * collides with the live target branch, (b) is automatically excluded from the
 * candidate `fingerprint` ref-hash (which filters `refs/harmonic/`), and (c)
 * follows the same `refs/harmonic/<purpose>/run-<id>` convention as the
 * candidate ref (issue #134).
 */
export const directRefFor = (runId: number): string => `refs/harmonic/direct/run-${runId}`;

/**
 * Detach the live checkout's HEAD at `startCommit`, parking the branch it was
 * on. Force-discards nothing of value: admission (#149) proved the context
 * clean, and `startCommit` is the current HEAD, so this only converts an
 * *attached* HEAD into a *detached* one at the same commit — after which the
 * agent's commits can no longer advance the live target branch.
 *
 * Must run after the start-state is recorded and before the agent is spawned.
 */
export async function detachForDirectRun(repoDir: string, startCommit: string): Promise<void> {
  await Git.checkoutDetach(repoDir, startCommit);
}

/**
 * Pin the private direct ref to the checkout's current HEAD — the tip of the
 * agent's commit chain (or the start commit, if the agent left its work
 * uncommitted in the working tree). This is where "agent commits land on a
 * private ref" becomes literally true: the commits are now reachable from an
 * owned Harmonic ref, not merely the HEAD reflog. Idempotent
 * (`setRef` create-or-move), so a re-run or double-call is safe.
 *
 * @returns the pinned OID.
 */
export async function captureDirectHead(repoDir: string, runId: number): Promise<string> {
  const head = await Git.revParse(repoDir, 'HEAD');
  await Git.setRef(repoDir, directRefFor(runId), head);
  return head;
}

/**
 * Restore the live target checkout coherently at settle: re-attach HEAD to
 * `startBranch` (which never moved while the Run executed detached) and sweep
 * the agent's tracked changes (`checkout -f`) and untracked files (`clean -fd`,
 * ignored files preserved). The result matches the clean context admission
 * (#149) recorded at Run start; the agent's work is not lost — it lives in the
 * candidate (#134) and the private direct ref ({@link captureDirectHead}).
 */
export async function restoreLiveCheckout(repoDir: string, startBranch: string): Promise<void> {
  await Git.checkoutForce(repoDir, startBranch);
  await Git.cleanUntracked(repoDir);
}

/**
 * Rematerialise a frozen candidate into a checkout for a corrective / review-
 * reject continuation turn: detach HEAD at `candidateOid` and sweep untracked
 * files, so the next turn resumes from the exact frozen candidate tree rather
 * than a stale or restored live checkout. Detached, so the continuation's own
 * commits stay off the live target branch exactly as the first turn's did.
 */
export async function rematerializeCandidate(repoDir: string, candidateOid: string): Promise<void> {
  await Git.checkoutDetach(repoDir, candidateOid);
  await Git.cleanUntracked(repoDir);
}
