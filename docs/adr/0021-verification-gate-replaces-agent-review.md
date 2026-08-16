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
