# A Verification gate (command and/or agent) replaces the agent-review flag

Before a Run's result merges (afk) or reaches awaiting-review (native), an
optional Verification runs in the Run's Work Context. It is a command
(the Workspace's test/lint), an agent (a critic Harness with its own configurable
prompt and model), or both, resolved from a global default with a per-Workspace
override. Its verdict is pass, fail, or inconclusive. Inconclusive fails
safe (Escalate, never a silent pass); a fail drives a bounded self-heal in
the same Session before Escalating. The agent verifier replaces the older
`agentReview` flag; its pass is what auto-accepts where configured.

We chose this because completion today rests entirely on a human read (native) or
a closed ticket (mirrored), with no automated "did it really do it" check. That is
the exact agent-claims-done-but-isn't failure the stronger systems in the field
(Sculptor, Factory Droid Control) gate against. The existing `agentReview` flag
(an agent calling `accept_task`/`reject_task`) is a weaker, separate mechanism
for the same job.

## Considered options

- Human or ticket gate only (rejected). Misses false-done and loads every
  check onto the reviewer.
- Mandatory verify, red just Escalates, no self-heal (rejected). Simpler, but
  throws away the cheap, measured win of letting the agent fix its own lint/test
  failure in warm context (Aider's reflection loop, SWE-agent's revert-on-lint).
- Command and/or agent, self-heal then Escalate, replaces `agentReview`
  (chosen). One Verification concept spans the mechanical check (test/lint) and
  the judgment check (critic); pass drives auto-accept, folding in the old flag
  rather than running two parallel agent-review paths.

## Consequences

- Inconclusive is treated as fail-safe (Escalate). False-completing is worse
  than an extra human look.
- The self-heal reuses the same Session (ADR-0020) within the cache window,
  up to a small cap, then Escalates.
- Verification runs at settle for both origins and blocks auto-merge when
  red.
- The `agentReview` config flag is removed; its behavior is subsumed by the
  verify-agent's pass then auto-accept.

## Reconciliation with the v5 design (post-Codex review)

Decision holds (Verification, command and/or agent, replaces `agentReview`).
The review refined it: it runs as a pipeline against a frozen candidate OID
(validate, candidate snapshot via a private ref/`commit-tree`, verify in a
disposable checkout, self-heal, re-verify the full suite); the critic is
read-only, with no mutating tools or creds, emits a structured schema verdict, and
is injection-contained (inconclusive/malformed goes to Escalate; only actionable fails
self-heal). Self-heal runs in the builder Session and re-enters `validating`.
Native review precedes landing (`verifying`, `review`, `landing`), governed by an
explicit origin by verifier by verdict by merge-fate table. Mirrored closes the
ticket only after verify and land, Merge-Fate-specific, reopening/escalating on
every non-success disposition. `agentReview` removal is an authorization
migration. See `docs/reliability-design.md` Unit B.

## Amendment (2026-08-22): the critic is a tool-enabled independent evaluator

The original containment ("read-only, no mutating tools/creds ... a delimited
untrusted diff") made the critic almost useless in practice: with no tools and only
a capped diff, it could neither read the surrounding code nor read the issue it was
meant to validate against, so it fell to `inconclusive` far too often. The critic is
now an independent evaluator that reviews the candidate the way a human reviewer
would:

- No injected diff. `buildCriticPrompt` no longer embeds a diff (and the
  nonce/delimiter machinery is gone). The critic reads the candidate itself from the
  disposable detached worktree it already runs in.
- Operator-authored, interpolated prompt. The whole review note is the operator's
  configured `verification.critic.prompt`, supporting the same
  `{skill}/{ref}/{url}/{title}/{body}` interpolation as the Drive Prompt (issue #33),
  so it can name and reach the issue. Harmonic still appends the read-only instruction
  and the strict JSON verdict contract; the settings UI shows the full compiled prompt.
- Builder-equivalent tool access. The critic gets the same unattended permission
  posture as the afk builder (a permissive session mode; any `request_permission` is
  granted) and may execute tools (read, grep, run a build, fetch the issue). It is
  held read-only by its prompt and by the post-turn mutation fingerprint (a
  critic that mutated the tree it reviewed is forced to `inconclusive`), not by
  withholding tools.

What is retained from the original containment: no Harmonic MCP server and
stripped tracker credentials (`HARMONIC_API_KEY`/`HARMONIC_MCP_URL`), so the critic
can never reach the tracker. It cannot `finish_task`/`accept_task`, only return a
verdict. Also retained: the disposable-worktree mutation fingerprint, and the strict schema verdict
with inconclusive/malformed going to Escalate. The verdict's role in `combineVerdicts` and the
rest of Unit B are unchanged.

## Amendment (2026-08-25): the Runner injects merge-cleanliness as a trusted fact

The critic must never run git. It reviews inside a disposable detached worktree
whose before/after fingerprint force-downgrades any mutating turn to
`inconclusive` (the fail-safe above), so a `git merge`/`git rebase` the critic
runs to check merge-cleanliness mutates the worktree and wrongly turns a genuine
`pass` into `inconclusive`. An operator critic prompt that told the critic to do
exactly that was the observed cause.

So the Runner computes merge-cleanliness itself, read-only, in the base repo (never
the disposable worktree), via `Git.mergeCleanliness` — `git merge-tree --write-tree
<baseBranch> <candidateOid>`, which writes only objects, moves no ref, and touches
no working tree — and injects the result into the critic prompt as a TRUSTED fact
(`buildCriticPrompt`'s `mergeCleanliness`), alongside the operator prompt and
operator note. The critic judges "does it merge cleanly into the base branch?" from
that fact without running any git command. A missing/unresolvable base branch or an
errored `merge-tree` yields no fact (omitted, backward compatible) and never fails
the Run. The mutation fail-safe itself is unchanged — this removes the critic's
*reason* to touch git, it does not weaken the guard.
