# A Verification gate (command and/or agent) replaces the agent-review flag

Before a Run's result merges (afk) or reaches *awaiting-review* (native), an
optional **Verification** runs in the Run's Work Context — a **command** (the
Workspace's test/lint), an **agent** (a critic Harness with its own configurable
prompt and model), or both — resolved global default with a per-Workspace
override. Its verdict is **pass / fail / inconclusive**: *inconclusive* fails
safe (Escalate, never a silent pass); a *fail* drives a **bounded self-heal** in
the same Session before Escalating. The agent verifier **replaces** the older
`agentReview` flag — its *pass* is what auto-accepts where configured.

We chose this because completion today rests entirely on a human read (native) or
a closed ticket (mirrored), with no automated "did it really do it" check — the
exact *agent-claims-done-but-isn't* failure the stronger systems in the field
(Sculptor, Factory Droid Control) gate against. The existing `agentReview` flag
(an agent calling `accept_task`/`reject_task`) is a weaker, separate mechanism
for the same job.

## Considered options

- **Human / ticket gate only (rejected).** Misses false-done and loads every
  check onto the reviewer.
- **Mandatory verify, red just Escalates, no self-heal (rejected).** Simpler, but
  throws away the cheap, measured win of letting the agent fix its own lint/test
  failure in warm context (Aider's reflection loop, SWE-agent's revert-on-lint).
- **Command and/or agent, self-heal then Escalate, replaces `agentReview`
  (chosen).** One Verification concept spans the mechanical check (test/lint) and
  the judgment check (critic); *pass* drives auto-accept, folding in the old flag
  rather than running two parallel agent-review paths.

## Consequences

- *inconclusive* is treated as fail-safe (Escalate) — false-completing is worse
  than an extra human look.
- The self-heal reuses the **same Session** (ADR-0020) within the cache window,
  up to a small cap, then Escalates.
- Verification runs at settle for **both** origins and **blocks auto-merge** when
  red.
- The `agentReview` config flag is removed; its behavior is subsumed by the
  verify-agent's *pass → auto-accept*.

## Reconciliation with the v5 design (post-Codex review)

Decision holds (Verification — command and/or agent — replaces `agentReview`).
Refined by the review: it runs as a **pipeline** against a frozen candidate OID
(validate → candidate snapshot via a private ref/`commit-tree` → verify in a
**disposable checkout** → self-heal → re-verify the full suite); the critic is
**read-only, no mutating tools/creds**, emits a **structured schema verdict**, and
is injection-contained (inconclusive/malformed → Escalate; only actionable fails
self-heal). **Self-heal runs in the builder Session and re-enters `validating`.**
**Native review precedes landing** (`verifying → review → landing`), governed by an
explicit origin × verifier × verdict × merge-fate table. **Mirrored closes the
ticket only after verify + land**, Merge-Fate-specific, reopening/escalating on
every non-success disposition. `agentReview` removal is an **authorization
migration**. See `docs/reliability-design.md` Unit B.

## Amendment (2026-08-22): the critic is a tool-enabled independent evaluator

The original containment ("read-only, no mutating tools/creds ... a delimited
untrusted diff") made the critic almost useless in practice: with no tools and only
a capped diff, it could neither read the surrounding code nor read the issue it was
meant to validate against, so it fell to `inconclusive` far too often. The critic is
now an **independent evaluator** that reviews the candidate the way a human reviewer
would:

- **No injected diff.** `buildCriticPrompt` no longer embeds a diff (and the
  nonce/delimiter machinery is gone). The critic reads the candidate itself from the
  disposable detached worktree it already runs in.
- **Operator-authored, interpolated prompt.** The whole review note is the operator's
  configured `verification.critic.prompt`, supporting the **same
  `{skill}/{ref}/{url}/{title}/{body}` interpolation as the Drive Prompt** (issue #33),
  so it can name and reach the issue. Harmonic still appends the read-only instruction
  and the strict JSON verdict contract — the settings UI shows the full compiled prompt.
- **Builder-equivalent tool access.** The critic gets the **same unattended permission
  posture as the afk builder** (a permissive session mode; any `request_permission` is
  granted) and **may execute tools** (read, grep, run a build, fetch the issue). It is
  held read-only by its **prompt** and by the post-turn **mutation fingerprint** (a
  critic that mutated the tree it reviewed is forced to `inconclusive`), **not** by
  withholding tools.

What is retained from the original containment: **no Harmonic MCP server** and
**stripped tracker credentials** (`HARMONIC_API_KEY`/`HARMONIC_MCP_URL`), so the critic
can never reach the tracker — it cannot `finish_task`/`accept_task`, only return a
verdict; the disposable-worktree mutation fingerprint; and the strict schema verdict
with inconclusive/malformed → Escalate. The verdict's role in `combineVerdicts` and the
rest of Unit B are unchanged.
