# Decision: Verification and the critic

Status: accepted
Date: 2026-08-28
Reconciled: 2026-10-02. Staged verifier lists follow ADR-0028/0037; merge-time checkout placement follows ADR-0039.

Part of the 2026-08-28 ADR reset (see README.md). The in-place critic is
implemented (#385): the provisioned checkout, its index management, the mutation
fingerprint, and merge-cleanliness are gone; restraint is by prompt instruction.

Amended 2026-09-08: the verify commands run in place too (see "Verify commands
run in place"). The disposable per-Attempt detached worktree — the last of the
frozen-tree machinery the reset missed — is deleted; a detached checkout is
retained only where no live checkout of the target commit exists.

Superseded in part by ADR-0028 (2026-09-08): the single-critic Review model and
the whole-Epic-verify-without-resolve clause are replaced by staged Verification
(commands + a list of critics at three stages) and an Epic that runs Attempts.
The in-place doctrine and verdict-attaches-to-Attempt rule below stand and
extend to every stage.

## The Verification gate

Verification runs at the stages defined by ADR-0028:
`verify.task.preMerge`, `verify.task.postMerge`, and `verify.epic.preMerge`.
Each stage runs ordered, fail-fast commands followed by parallel critics;
all critics must pass. Global lists and id-keyed Workspace overlays resolve
under ADR-0037. A stage with zero enabled verifiers passes.

Any command fail, review reject, or review `inconclusive` is a **failed
Attempt**: feedback flows into the next Attempt, counter +1. `inconclusive`
burns an Attempt rather than escalating directly — the loop stays uniform.

**A verdict attaches to the Attempt, never to a SHA** (ADR-0001). Merging
never re-checks it, and base movement never invalidates it.

## Verify commands run in place

Like the critic, the verify commands run **in place** in the Attempt's builder
worktree (or the live checkout in direct mode). That worktree already sits at
the candidate head the Attempt committed, so there is no separate disposable
checkout and no frozen-tree machinery. One Attempt owns one worktree with one
agent: there is no concurrent reader a mutating command must be isolated from,
and a command that does mutate touches only that worktree — the same accepted,
logged tradeoff (ADR-0010) already recorded for the critic. Running in place
also means a command sees exactly what the agent produced, including any
sibling checkouts the agent set up under the worktree — a detached checkout of
the base tree alone would silently omit them.

Task and Epic post-merge commands run in the ephemeral administrative
worktree already owned by the merge operation (ADR-0039). Commands in that
stage share the checkout, so artifacts and mutations remain visible to later
commands. They do not create a fresh checkout per verifier or mutate the
operator's base checkout. The Epic-to-default-branch post-merge check reuses
the `verify.epic.preMerge` commands and runs no critics.

## The critic is an independent, tool-enabled evaluator

The critic reviews the way a human reviewer would:

- **It is given both revisions**: the base and the candidate of the Task's
  branch. It reads the code itself — no injected diff, no delimiter/nonce
  machinery.
- **Operator-authored, interpolated prompt.** The review note is the
  operator's configured critic entry, supporting the same
  `{skill}/{ref}/{url}/{title}/{body}` interpolation as the Drive Prompt, so
  it can name and reach the issue. Harmonic appends the restraint
  instruction and the strict JSON verdict contract; the settings UI shows the
  full compiled prompt.
- **It reviews in place, with no enforcement machinery.** The critic runs
  against the Task's worktree (or the live checkout in direct mode) with the
  same unattended permission posture as the builder. There is no disposable
  checkout, no permission-mode forcing, no mutation fingerprint, and no
  pre-computed merge-cleanliness fact — restraint is by prompt instruction
  ("read, don't write; run nothing that mutates"), and recovery from a critic
  that misbehaves is `git revert` / `git checkout`, priced for one operator's
  laptop. **Accepted tradeoff, recorded**: an instructed-but-unrestricted
  critic can in principle dirty the worktree or run external tools; this is
  accepted by owner decision and made diagnosable — not prevented — by
  ADR-0010's logging doctrine (every critic turn is a logged Operation).
- **Harmonic does not provide its MCP server or execution credentials to the
  critic.** `HARMONIC_API_KEY` and `HARMONIC_MCP_URL` are stripped. Other
  ambient environment credentials are inherited; this is the explicitly
  accepted single-operator risk in ADR-0019, not a claim of network or
  tracker isolation.
- **Strict schema verdict.** Malformed output is `inconclusive`, which fails
  the Attempt.

## Critic transcripts are persisted by locator

Each critic attempt persists a nullable `transcript_path` locator (resolved
from the harness's native session log before the turn's context is gone), and
the operator UI renders the critic's native JSONL on demand through the same
parse-on-demand path as builder logs (ADR-0007). A missing transcript renders
"log unavailable" with the reason — never a fabricated log. The critic is
deliberately **not** a first-class, resumable Session: single-shot, never
resumed; the locator lives on the attempt.

## Verification is always visible

A derived per-Attempt verifier status is always renderable, computed by
reconciling the resolved configuration (`resolveVerifiers()`) against the
recorded attempts:

- `planned` — configured; verification not yet reached in this Attempt.
- `passed` / `failed` / `inconclusive` — an attempt was recorded.
- `skipped` — configured, verification reached, but no attempt produced.
- `disabled` — not configured; still rendered as a muted row, never omitted.

The Verification panel never returns null; each Attempt row carries an
at-a-glance verification chip; a missing critic transcript states *why*.
The transcript view distinguishes the main agent from subagents via the
harness's own attribution (`parentToolUseId`), grouping a subagent's events
under the tool call that spawned it and degrading gracefully to the flat main
stream where attribution is absent.

Validation judges the **resolved** config (ADR-0009): an
effectively-enabled-but-unrunnable verifier ("review on, no model resolved")
is a loud, visible state on the settings surface, never a silent no-op.

## Consequences

- The critic-checkout provisioning, its index management, the mutation
  fingerprint, and `Git.mergeCleanliness` are deleted with the frozen-tree
  model.
- The command verifier's disposable per-Attempt detached worktree is deleted;
  it runs in the builder worktree via the same cwd resolution as the critic.
  Administrative post-merge checks reuse the merge operation worktree
  (ADR-0039).
- `skipped` vs `disabled` classification is a best-effort display
  reconciliation, not a persisted fact; if it misleads, persisting the
  resolved-verifier set onto the Attempt is the follow-up.
- Subagent attribution depends on the Harness Adapter's native log support.
  Missing attribution falls back to a flat stream; it is never fabricated.

## Absorbed at the reset

Pre-reset 0021 core + its 2026-08-22 amendment (as amended here: in-place,
instruction-restrained, both revisions; the 2026-08-25 merge-cleanliness
amendment is dropped), 0040, 0041's verification clauses, 0042 Decisions A
and C, 0044 Decision F. See README.md for the mapping.
