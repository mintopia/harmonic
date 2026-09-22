# Decision: Epic integration and branch retirement use an ephemeral worktree

Status: accepted
Date: 2026-09-22

Amends ADR-0001's "One merge policy, everywhere" rule for the epic to default-branch path.

## Context

ADR-0001 requires the same merge policy for Task and Epic integration, but it
does not say where the Epic integration merge and the following retirement run.
Running either operation in a Workspace's base checkout can change its HEAD,
current branch, or working tree. That checkout belongs to the operator, not to
an Epic operation.

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

The base checkout's HEAD, checked-out branch, and working tree MUST remain
unchanged by both operations. The ephemeral worktree may create the integration
merge commit, run the required post-merge verification, update the target ref,
and delete the contained Epic branch. Harmonic removes it after the operation,
including after failure on a best-effort basis that records any cleanup error.

The existing ephemeral Task-merge path in `src/execution/branch-merge.ts` is
covered by this decision. Task and Epic integration therefore share both the
merge policy in ADR-0001 and the checkout-isolation rule here.

The ephemeral worktree is an administrative operation site, not a detached
verification environment. Verification still follows ADR-0028: it runs in the
live worktree at the target commit when one exists. The epic-to-default
post-merge check has no live target checkout, so it runs in the ephemeral
operation worktree and records its result there.

## Consequences

- An Epic operation cannot leave the operator's base checkout on another
  branch, at another commit, or with generated or conflicted files.
- Integration and retirement code must take an ephemeral-worktree path before
  executing any command that can alter refs, HEAD, the index, or the worktree.
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
