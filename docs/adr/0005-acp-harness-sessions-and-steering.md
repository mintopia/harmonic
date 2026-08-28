# Decision: Harness integration over ACP, Sessions, and steering

Status: accepted
Date: 2026-08-28
Part of the 2026-08-28 ADR reset (see README.md).

## ACP is the only harness integration protocol

Harmonic drives all harnesses (Claude, Codex, Copilot) exclusively over ACP —
stdio JSON-RPC with structured streaming. The one-shot CLI modes are
deliberately unsupported, even as fallback: one code path, uniform real-time
observability, no second-class degraded mode. Neither Claude nor Codex speaks
ACP natively; the canonical adapter packages
(`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`)
are part of the vendor surface Harmonic depends on.

- ACP does not standardise token usage: Usage **collection** is per-harness
  native session-log parsing (the Usage Collector; metric semantics live in
  ADR-0008), with ACP `_meta` fields used where emitted.
- ACP does not standardise model selection: the model pin is a **Harness
  Adapter** concern — spawn-time env for Claude/Codex, `session/set_model`
  after `session/new` for Copilot. The observed model is verified from Usage
  and a contradiction is surfaced on the Attempt.
- All harness-specific knowledge (spawn quirks, model pin, Usage Collector)
  lives behind the per-harness Harness Adapter; operator config holds only
  what is genuinely operator-tunable.

## Sessions are first-class and resumable

A **Session** is one ACP conversation with a harness, 1:1 with the harness's
own `sessionId`, a durable first-class resource with a Harmonic-generated id
(the harness `sessionId` alone cannot reload one).

- **Resume is `session/load` into a fresh harness process** — a new Attempt
  and a new prompt turn on a loaded Session, never reattaching a dead process
  or an outstanding tool call. The `loadSession` capability is read from the
  `initialize` response; resume eligibility is a compatibility matrix
  (harness match, capability present, permission mode establishable).
- **Warmth is a cost signal, never a correctness gate.** `session/load` is
  valid warm or cold; warmth only changes cost and latency. The per-harness
  warm window is a cost estimate (`estimatedWarmUntil`) Harmonic controls at
  spawn where it can (Claude's 1-hour prompt-cache TTL via
  `ENABLE_PROMPT_CACHING_1H=1`), never a promise. There is no keepalive: an
  agent turn is not a side-effect-free cache ping.
- **Credential-free MCP templates are minted fresh at load**; load-time
  `session/update` replay is quarantined from current-turn usage and
  progress detection.
- **The continuation rule** (deterministic, at Attempt N+1): continue the
  prior Session — feedback appended — iff its context usage is below
  `contextReuseThreshold` AND it is warm; otherwise a fresh Session seeded by
  the condensed continuation plus the feedback. The repo is the diff. The
  warm-Session "start now" override on reject is ADR-0002's.
- A Session moves `active → idle → retiring → retired`. Worktree removal is
  owned by the **Task**, not the Session (ADR-0001).

## Steering a running task

An operator can redirect a running agent: `POST /tasks/:id/steer` with
`{ text }`. Seven clauses survive the reset intact:

1. **Mid-turn ACP injection first.** When a turn is in flight and the harness
   supports `_session/steering`, the message is injected into the running
   turn at steer priority (pre-empting generation without cancelling it); a
   `steer_injected` event records it, and the steered output streams over the
   existing prompt await.
2. **Turn-boundary queue as fallback.** Otherwise the steer is held on the
   in-memory queue and delivered as a fresh turn at the next boundary, ahead
   of any auto-drive continue nudge (`steer_queued` / `steer_delivered`
   events keep the transcript honest).
3. **Capability by try-and-fallback, latched per execution.** The handshake
   exposes no steering capability; a "method not found" latches
   `steerSupported = false` so the probe happens once.
4. **Steers never spend the continue budget.** The attempt/continue counter
   counts only auto-drive nudges.
5. **Operator-only, excluded from scoped keys** — an agent does not steer
   itself.
6. **Delivered-or-409, never accepted-then-lost.** A synchronous gate rejects
   a steer the instant the drive loop commits to settling; a steer that raced
   in before the close is drained as a final turn. Injected, queued, and
   delivered facts are recorded.
7. **Cancel-and-re-prompt stays a Conversation behaviour** (ADR-0006);
   steering a task never discards the current turn's work.

## Consequences

- Vendor-surface risk is accepted: adapter packages, log formats, and
  Copilot's ACP quirks are integration surfaces that fail loudly, never
  silently.
- Boot recovery reconstructs in-flight state from the DB and resumes via
  `session/load` where the compatibility matrix allows; otherwise the Attempt
  fails safe and the Task requeues by the normal rules.

## Absorbed at the reset

Pre-reset 0001 in full, 0020 core (keepalive, reattach, hardcoded window, and
reliability-design references dropped), 0041's continuation rule, 0018 in
full including its mid-turn amendment. See README.md for the mapping.
