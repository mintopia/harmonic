# Decision: Verification and the critic

Status: accepted
Date: 2026-08-28
Part of the 2026-08-28 ADR reset (see README.md). Target-state: the critic
still runs in a provisioned checkout in current code; this ADR wins.

## The Verification gate

Before a Task's work merges, an optional Verification runs inside each
Attempt: the deterministic **verify commands** (`verify.commands[]`, ordered,
fail-fast, one Verification Step each), then the optional **critic** — a
single review agent with configurable harness, model, and prompt, run only
after all commands pass (gate-on-pass). Resolved as a global default with a
per-Workspace override; zero verifiers configured means the gate passes.

Any command fail, review reject, or review `inconclusive` is a **failed
Attempt**: feedback flows into the next Attempt, counter +1. `inconclusive`
burns an Attempt rather than escalating directly — the loop stays uniform.

**A verdict attaches to the Attempt, never to a SHA** (ADR-0001). Merging
never re-checks it, and base movement never invalidates it.

## The critic is an independent, tool-enabled evaluator

The critic reviews the way a human reviewer would:

- **It is given both revisions**: the base and the candidate of the Task's
  branch. It reads the code itself — no injected diff, no delimiter/nonce
  machinery.
- **Operator-authored, interpolated prompt.** The review note is the
  operator's configured `verification.critic.prompt`, supporting the same
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
- **It can never reach the tracker or the Harmonic API**: no Harmonic MCP
  server, and tracker credentials (`HARMONIC_API_KEY` / `HARMONIC_MCP_URL`)
  are stripped from its environment. It cannot `finish_task` or
  `accept_task`; it only returns a verdict.
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
- `skipped` vs `disabled` classification is a best-effort display
  reconciliation, not a persisted fact; if it misleads, persisting the
  resolved-verifier set onto the Attempt is the follow-up.
- Subagent attribution is Claude-harness-specific today; other harnesses fall
  back to the flat stream until a per-harness mapping is added.

## Absorbed at the reset

Pre-reset 0021 core + its 2026-08-22 amendment (as amended here: in-place,
instruction-restrained, both revisions; the 2026-08-25 merge-cleanliness
amendment is dropped), 0040, 0041's verification clauses, 0042 Decisions A
and C, 0044 Decision F. See README.md for the mapping.
