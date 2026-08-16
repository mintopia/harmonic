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
