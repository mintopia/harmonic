# Decision: Epic integration and branch retirement use an ephemeral worktree

Status: accepted
Date: 2026-09-22
Amended: 2026-09-22 (base-checkout sync rule; direct-mode Epics)

Amends ADR-0001's "One merge policy, everywhere" rule for the epic to default-branch path.

## Context

ADR-0001 requires the same merge policy for Task and Epic integration, but it
does not say where the Epic integration merge and the following retirement run.
Running either operation in a Workspace's base checkout can switch its current
branch or leave it mid-merge. That checkout belongs to the operator, not to an
Epic operation: its branch (for example `develop`) is outside Harmonic's
control. The failure that prompted this decision was Harmonic checking the
Epic branch out in the base checkout to merge it back, which moved the
operator off `develop`.

The operator does want the merge result in that checkout. Integrating into
`develop` means the base checkout, still on `develop`, shows the merged work,
and it must do so without overwriting or reversing the operator's
uncommitted changes.

Task branch merges already create a disposable worktree in
`src/execution/branch-merge.ts`. There is no ADR decision for that placement,
and the Epic path must not use a weaker rule.

ADR-0028 rejects disposable verification checkouts because they hide mutations
that a verifier makes. An ephemeral worktree for an administrative merge is
different: it is the place where the mutation happens, and the operation and
its result remain observable. It protects the operator's checkout rather than
hiding a verifier's effects.

## Decision

Epic integration into the default branch and retirement of `epic/<ref>` MUST
run in one or more disposable, ephemeral worktrees created from the Workspace
repository. They MUST NOT run in the Workspace's base checkout.

Harmonic MUST NOT switch the base checkout's branch, detach its HEAD, or run a
merge, conflict resolution, or retirement in it. The ephemeral worktree may
create the integration merge commit, run the required post-merge verification,
update the target ref, and delete the contained Epic branch. Harmonic removes
it after the operation, including after failure on a best-effort basis that
records any cleanup error.

### The merge result reaches the base checkout, on its own branch

When the updated target branch is the one checked out in the base checkout,
Harmonic brings that checkout's files forward to the merge result, path by path
over the paths the merge changed:

- A path the operator has not touched is updated to the merge result.
- A path both the operator and the merge changed gets a three-way content
  merge. If it merges cleanly the file holds both changes. Otherwise the
  operator's file is left byte-for-byte as it was, and the path is reported
  for the operator to reconcile.
- Paths the merge did not change keep the operator's changes, staged state
  included.

Harmonic never writes conflict markers, discards uncommitted work, or leaves
the checkout showing the merge as reversed. A dirty base checkout never blocks
or fails the merge, because the target ref is already published when the sync
runs. The sync is recorded as a merge step that is visible in the UI, listing
the paths that were merged and the paths kept at the operator's version. When
the target branch is not checked out in the base checkout, nothing in it
changes.

### Direct mode has nothing to isolate

Direct mode works in the base checkout by definition (ADR-0001, "Isolation
modes"): there is no branch, no ephemeral worktree, and nothing to merge. An
Epic whose Members all run in direct mode has no Integration branch. Harmonic
never creates, checks out, or switches a branch for it. It completes in place:
once every Member is done it is recorded as integrated with no merge commit,
its ticket is closed, and its timeline records the completion. It has no Epic
Pre-Merge Verification, Epic Attempt, integration merge, or retirement. A
pre-existing `epic/<ref>` for such an Epic is never refreshed, merged, or
retired. Harmonic leaves it untouched, and the completion record notes it. An
Epic with any worktree-mode Member keeps its Integration branch and everything
above.

The existing ephemeral Task-merge path in `src/execution/branch-merge.ts` is
covered by this decision. Task and Epic integration therefore share both the
merge policy in ADR-0001 and the checkout-isolation rule here.

The ephemeral worktree is an administrative operation site, not a detached
verification environment. Verification still follows ADR-0028: it runs in the
live worktree at the target commit when one exists. The epic-to-default
post-merge check has no live target checkout, so it runs in the ephemeral
operation worktree and records its result there.

## Consequences

- An Epic or Task operation cannot leave the operator's base checkout on
  another branch, with conflict markers, or with uncommitted work overwritten
  or shown reversed. It may advance the checked-out branch and its files to
  the merge result.
- A path the operator must reconcile after a conflicting three-way sync holds
  their own content, and the merge step reports it.
- All-direct Epics trade Epic Pre-Merge Verification for in-place completion.
  Members in one checkout run one at a time, so each verifies on top of the
  Members before it. This is ADR-0001's accepted direct-mode tradeoff.
- Integration and retirement code must take an ephemeral-worktree path before
  executing any command that can alter refs, HEAD, the index, or the worktree.
  The one command that touches the base checkout is the per-path sync above,
  which never changes its branch.
- Cleanup failures do not permit reuse of the ephemeral worktree. Harmonic
  reports them so the operator can remove the disposable directory.
- ADR-0028's anti-observability rule continues to prohibit detached verifier
  checkouts. It does not prohibit an observable administrative worktree that
  isolates an Epic integration operation from the base checkout.

## Supersedes

None wholesale. This amends ADR-0001's "One merge policy, everywhere" rule by
requiring the Task and Epic integration paths to use ephemeral worktrees, and
clarifies ADR-0028's detached-checkout exception for the epic-to-default
post-merge check.
