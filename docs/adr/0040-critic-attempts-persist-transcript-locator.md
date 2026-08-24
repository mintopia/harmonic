# Decision: Critic verification attempts persist a transcript locator so the operator can view the critic's session log

Status: accepted
Date: 2026-08-24

## Context

The agent critic (ADR-0021) runs as a single read-only turn against a frozen
candidate, driven by `createAcpCriticDrive` in a disposable detached worktree.
That drive does its own ACP handshake and, in its `finally`, disposes the driver
and kills the child. The only artifact it returns is `{ output, permissionRequests }`;
`runCritic` persists the parsed `verdict`, `summary`, and raw `output` onto the
verification attempt. Nothing about the critic's session is recorded — no harness
`sessionId`, no transcript path.

Consequently the operator has no way to see what the critic actually did — which
files it read, what commands it ran, how it reached its verdict. This is most
acute for the Note-to-critic escape hatch (ADR-0027, issue #191): the operator
sends corrective feedback, the task stays escalated on a non-pass, and there is
no window into the critic's reasoning beyond a one-line summary. The critic is a
builder-equivalent, tool-enabled evaluator (ADR-0021 amendment), so "what did it
do" is real, inspectable work, not a black box.

The builder already solves exactly this. ADR-0031 records that the DB does not
store the session event stream; instead a `transcript_path` locator is persisted
at dispatch and the native harness JSONL (written to `~/.claude/projects/...`,
outside the worktree, so it survives worktree retirement) is parsed on demand,
with "log unavailable" as an acceptable outcome. The critic writes the same
native JSONL; it simply never captures the locator.

## Decision

Critic verification attempts persist a transcript-path locator, and the operator
UI renders the critic's native session log from it on demand — the same
mechanism ADR-0031 defined for builder runs, extended to critic attempts.

1. The critic drive surfaces its harness `sessionId` (from the ACP handshake)
   and resolves the transcript path via the harness adapter's existing
   `resolveTranscriptPath({ sessionLogDir, sessionId })`, before the worktree is
   disposed. `runCritic` receives the `sessionLogDir` from the Runner (as builder
   dispatch already does) and carries the resolved locator onto the
   `CriticAttempt`.

2. The locator is persisted as a nullable `transcript_path` column on the
   `verification_attempts` row (a Drizzle migration). It is exposed on the
   `VerificationAttempt` API type via its zod schema, keeping WS/REST parity.

3. The Verification panel gains a per-attempt "Critic session" view that parses
   and renders that JSONL through the existing on-demand log path. A missing or
   unwritten transcript shows "log unavailable" — no tee-to-file, copy, or
   retention machinery (ADR-0031 point 4 holds).

4. The critic is NOT promoted to a first-class, resumable Session (ADR-0020). A
   critic turn is single-shot, read-only, and never resumed; it needs a readable
   transcript, not a `sessions` row, a Harmonic session id, or `session/load`
   eligibility. The locator lives on the attempt, not on a Session entity.

## Considered options

- Persist the critic's raw `output` and stop there (rejected). It is already
  stored and could be surfaced cheaply, but `output` is only the critic's final
  text — it shows the conclusion, not the reads, greps, and builds that produced
  it, which is exactly the "what did it do" the operator is missing.

- Promote the critic to a first-class Session (ADR-0020) with a `sessions` row
  and Harmonic session id (rejected). Heavyweight for a single read-only turn:
  it drags in resume eligibility, credential-free MCP templates, and retirement
  sweeping the critic will never use. The locator-on-attempt extension of
  ADR-0031 delivers the log view at a fraction of the surface area.

- Ingest the critic's `session/update` stream into the DB (rejected). This is
  the precise write-amplification ADR-0031 removed to stop the event-loop peg;
  reintroducing it for the critic repeats the mistake.

## Consequences

- The operator can inspect the critic's full session for any attempt where the
  JSONL still exists on disk, including after a Note-to-critic re-review. The log
  is coupled to the harness's native format and location — the accepted cost of
  ADR-0009/0031; an absent transcript yields "log unavailable", never a
  fabricated log.
- ADR-0021 containment is unchanged: capturing a transcript path grants the
  critic no capability, tool, or credential. The read-only posture and the
  mutation fingerprint are untouched.
- A new nullable column on `verification_attempts` and its migration; the
  column is null for every historical attempt and for harnesses that write no
  native JSONL, both rendered as "log unavailable".
- The critic drive's return shape and `RunCriticArgs` grow a `sessionLogDir`
  input and a transcript locator output; the Runner must thread the same
  `sessionLogDir` it already resolves for builder dispatch into `runCritic`.

## Supersedes

None. Extends ADR-0031 (transcript locator, parse-on-demand, missing-is-acceptable)
to critic attempts; consistent with ADR-0020 (critic sessions are deliberately
not first-class) and ADR-0021 (containment unchanged).
