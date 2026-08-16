# Sessions are first-class and resumed within the cache-warm window

A **Session** — one ACP conversation with a Harness, 1:1 with the harness's own
`sessionId` — becomes a first-class, reusable resource. A retry, an automated or
human rejection, or a crash-resume continues in the **same** Session via
`session/load` while that harness's prompt cache is still warm; past the window a
**new** Session is opened that *references* the prior work. Harmonic starts
reading the `loadSession` capability from the `initialize` response (which it
discards today) and starts calling `session/load` (which it never does today).

We chose this because a crash mid-run currently fails the whole Run (fail-forward,
never resume) and every retry/reject starts a fresh cold Run, throwing away the
context the model already built. `session/load` is advertised by **all three**
harnesses (claude-code-acp, codex-acp, copilot `--acp`) yet is wired nowhere.

## Considered options

- **Keep fail-forward / a fresh Run every time (rejected).** Safe but wasteful —
  discards warm context and re-does work a restart interrupted.
- **Keep the harness process warm to preserve the live session (rejected).** Pins
  a process and a concurrency slot while idle, fighting the machine ceiling and
  the Work Context House Rule (ADR-0022). Resume must not depend on a live
  process.
- **`session/load` into a fresh process within the cache-warm window, else a
  new-Session-with-reference (chosen).** Resume is decoupled from the process,
  and the reuse window is matched to cache warmth so we never *automatically* pay
  a cold full-context reload.
- **Assume a fixed 5-minute window because cache TTL is opaque over ACP
  (rejected).** Cache TTL cannot be *read* over ACP, but it can be *controlled at
  spawn*: Claude Code requests the **1-hour TTL automatically on a Claude
  subscription**, and Harmonic (which spawns the harness) can force it on any auth
  with `ENABLE_PROMPT_CACHING_1H=1`. So the reuse window is a **per-Harness
  constant Harmonic sets and therefore knows** — ~**1 h for Claude**, ~5–30 min
  for Codex, ~5 min for Copilot (unverified) — not one opaque guess.

## Consequences

- **Boot recovery changes from fail-all to conditional:** an orphaned Run still
  within its window can reattach via `session/load`; otherwise it still fails
  (safe). To reconstruct an interrupted Run, the in-flight signals that are
  memory-only today — `steerQueue`, `agentFinished`, `escalateReason` — must be
  persisted.
- **Forcing the 1h TTL** on Claude via `ENABLE_PROMPT_CACHING_1H=1` bills cache
  *writes* at a higher rate but keeps reads cheap and avoids cold reprocesses —
  worth it for long autonomous runs and review gaps. Set it at spawn.
- **Keepalive:** the cache is a sliding window refreshed on each hit, so a cheap
  no-op turn holds a Session warm through a known wait (e.g. automated
  Verification, ADR-0021). It matters chiefly for the **short-window** harnesses
  (Codex/Copilot); with Claude's 1h window it is rarely needed. Driven off a
  client-side timer because ACP surfaces no cache signal; costs one cache-read per
  ping.
- **Reject splits by warmth.** An **automated** reject (verify-agent, fires in
  seconds) reuses the warm Session silently. A **human** reject is warm if the
  review lands inside the window (often, with Claude's 1h) and cold beyond it —
  so it opens an operator dialog showing **time since last active**: *reuse
  (reloads full context, costs more)* vs *fresh (summary)*.
- Run and Session stay distinct: "a retry is a new Run" still holds; the new Run
  binds to the same Session.
- Copilot's TTL and exact `loadSession` flag are unverified — default to the
  tightest window and confirm by measurement.

## Reconciliation with the v5 design (post-Codex review)

The review materially corrected this ADR — the passages above describing *reattach*,
a hardcoded warm window, and a *keepalive* are **superseded** by the following:

- **Cache warmth is a COST signal, not a correctness gate.** `session/load` is valid
  warm or cold; warmth only changes cost/latency. Resume eligibility is a
  **compatibility matrix**; the per-harness window is a cost *estimate*
  (`estimatedWarmUntil`), never a promise.
- **Resume = a new Run + a new prompt turn on a loaded Session** after repo
  reconciliation — **not** reattaching a dead process or an outstanding tool call.
- A first-class **Session entity** (Harmonic-generated id; **credential-free** MCP
  templates minted fresh at load) is required; `sessionId` alone cannot reload.
- **Keepalive is dropped** (an agent turn is not a side-effect-free cache ping).
- Load-time `session/update` replay is **quarantined** out of current-turn usage,
  `run_facts`, and progress detection.

See `docs/reliability-design.md` Unit C.
