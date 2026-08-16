# Harmonic owns branching; enforced by detect-at-settle, not prevention

The contract is that **Harmonic owns branch and worktree management; the agent
never creates or switches branches.** Because prevention is unreliable for an afk
Run, the contract is enforced by detection: **(1)** record the branch the Run
started on even in *direct* mode, **(2)** at settle verify HEAD is still on that
branch and no stray branch holds the work, **(3)** on a violation re-invoke the
agent (same Session, **one** corrective turn to merge its work back onto the
intended branch), then **Escalate** if still violated. It is modeled as a
branch-contract **Guardrail** (ADR-0019).

We chose this because direct mode today records *nothing* about the starting
branch, so an agent that runs `git checkout -b` strands its work on an untracked
branch — the diffstat computes `null`, nothing merges, and the stray branch can
even be left as HEAD and become the mis-recorded base of the next worktree Run.
Agents do this "when told not to," and Harmonic currently neither hints against
it nor notices it.

## Considered options

- **Prevent via ACP permission gating (rejected).** `bypassPermissions` fires no
  callback at all; `auto` auto-approves routine tool calls so a `git checkout -b`
  never surfaces; Harmonic has no allow/deny list of its own. Prevention at the
  permission layer cannot see the command.
- **Prevent via a git `reference-transaction` hook (rejected for v1).** True
  prevention, but it means Harmonic writing hooks into the user's repository —
  invasive. Revisit only if detection proves insufficient.
- **Instruct via the Drive Prompt alone (rejected as the sole mechanism).**
  Prompts do not bind, and the `/implement` and `/research` skills live in the
  *target* repo, not in Harmonic — so it cannot guarantee any branch instruction.
  Kept only as cheap belt-and-suspenders.
- **Record-start-branch + detect-at-settle + agent re-merge, else Escalate
  (chosen).** Never silently mistracks; recovery uses the agent (which knows what
  it changed) rather than a blind Harmonic cherry-pick that could clobber work.

## Consequences

- Direct-mode Runs now persist the branch they started on (new — Harmonic was
  blind to it).
- Violation recovery is one corrective agent turn (cap 1), then Escalate — the
  standard Guardrail outcome (ADR-0019).
- A Drive Prompt line tells the agent Harmonic owns branching (belt-and-
  suspenders, not relied on).
- Pairs with the Work Context House Rule (ADR-0022): the context stays locked
  until settle, so a stray branch cannot become the next Run's base.

## Reconciliation with the v5 design (post-Codex review)

Decision holds (Harmonic owns branching; enforced by detection). Hardened by the
review: validation runs in the `validating` phase **before** any commit/cleanup;
persist start OID + dirty fingerprint; **afk direct requires a clean context and
rejects submodules**; detached HEAD is rejected or needs an operator-selected
landing branch. **Direct-mode afk executes on a private detached Harmonic ref** so
agent commits never touch the live target; the candidate is built via
`commit-tree`/a private ref and rematerialized for corrective turns. **Owned-ref
tracking** makes unattributed ref deltas ambiguous (never auto-recovered).
**Landing is journaled + crash-idempotent**, in a dedicated admin worktree, with an
expected-old-OID CAS and a **point of no cancellation**. **Deterministic git
recovery is preferred**; agent re-merge is a bounded fallback whose success is
defined as matching an allowed commit-set/tree-diff, else Escalate. See
`docs/reliability-design.md` Unit D and §0.3.
