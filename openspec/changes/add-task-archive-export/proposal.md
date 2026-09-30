# Change: Add per-Task Archive and terminal-disposition Export

## Why

An operator cannot review a finished Task end to end. Harmonic owns no
transcript (only a locator into the Harness's native JSONL, which the Harness
may prune or never write), verify-command output is truncated to its first
200k characters, some operator inputs (Accept, Close/Cancel actor and reason)
are not recorded, and the DB is disposable by design (ADR-0007). Teams that
need to audit autonomous work, or keep it beyond the life of the instance,
have no way to do so.

## What Changes

- **Archive (always on):** every Task gets a Harmonic-owned file Archive in the
  data directory — never in the DB — holding every implementation and Critic
  transcript (ACP stream tee plus native JSONL copy), the full uncapped output
  of every verify command, every resolved prompt, and every operator input.
- Archives are keyed by a per-Task UUID `archiveId`, outlive Task Delete and DB
  recreation, and are pruned only by an optional retention cap.
- Log views fall back to the Archive copy when the native transcript is gone.
- Verify-command DB preview changes from head-only to head+tail with a
  truncation marker.
- New recorded Facts: operator Accept; Close/Cancel with actor and reason.
- **Export (optional):** on every terminal disposition (*done*, *cancelled*,
  Delete of a Task with any Attempt) Harmonic builds a redacted `.tar.gz` and
  writes it to each configured Export Destination (directory and/or
  S3-compatible bucket), with retries, failure surfacing, and manual
  re-export/download.
- Epic Exports carry the Epic's own Attempts, timeline, and references to
  Member Exports.
- Configurable redaction patterns (baseline set + additive global/Workspace).
- New settings, global with per-Workspace override; S3 credentials masked.
- **BREAKING (policy):** supersedes the ADR-0007 clause forbidding
  tee-to-file / copy-on-dispatch / retention machinery. The DB still never
  stores the event stream.

## Impact

- Decision: `docs/adr/0044-task-archive-and-export.md` (supersedes part of
  ADR-0007). Glossary: `CONTEXT.md` — Archive, Export, Export Destination.
- Affected specs: new capabilities `task-archive`, `task-export`.
- Affected code (indicative):
  - `src/execution/turn-listeners.ts`, `src/execution/transcript-capture.ts`
    — ACP tee and native copy
  - `src/verification/command-verifier.ts`, `verification-coordinator.ts`,
    `post-merge-check.ts` — full output stream, head+tail preview
  - `src/server/transcript-log.ts`, `routes/tasks.ts` — Archive fallback
  - `src/domain/attempt-settle.ts`, Delete path, `escalation.ts` — Export
    trigger, new operator-input Facts
  - `src/config.ts`, `src/baseline.yaml`, `routes/config.ts` — settings and
    secret masking
  - Scheduler — retention prune and Export retry Scheduled Jobs
  - `src/db/schema.ts` — `tasks.archive_id`
  - Web UI — Ticket-page Export panel, Settings "Archive & Export" section
- New dependencies: a tar writer; an S3 client (or SigV4 signing).
- Out of scope: Conversations; backfill of Tasks finished before release.
