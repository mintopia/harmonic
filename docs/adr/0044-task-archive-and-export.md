# Decision: Every Task keeps a file Archive, exported on terminal disposition

Status: accepted
Date: 2026-09-30

## Context

An operator must be able to review, after the fact, everything that happened
on a Task: what every agent (implementation and Critic) did and was told, what
every verify command printed, and what every human input was. Today that is
not possible:

- Harmonic owns no transcript. It persists only a locator to the Harness's
  native JSONL (`sessions.transcript_path`, `verification_attempts.transcript_path`);
  when the Harness prunes its logs (Claude defaults to ~30 days) or writes
  none, the log is gone. Reads are also tail-capped (2 MiB / 2000 events).
- Verify-command output is stored in `verification_attempts.output`, capped at
  200k characters keeping the head, so the failing tail is silently dropped.
- Operator Accept has no dedicated event; Close/Cancel record no actor or
  reason.
- The DB is disposable by design (ADR-0007 clean-break policy) and Task ids are
  autoincrement integers reused after a recreate.

ADR-0007 explicitly forbade "tee-to-file, copy-on-dispatch, or retention
machinery". That clause protected the DB from the `run_events` firehose
(375 MB of a 427 MB DB); its motive was the DB and the event loop, not
auditability.

## Decision

**Archive (always on).** Each Task gets a Harmonic-owned **Archive**: files in
the data directory, **never in the DB**, at
`archive/<workspace>/<taskId>-<archiveId>/`, where `archiveId` is a UUID
assigned at Task creation (so ids reused after a DB recreate never collide).
An `archive.json` stub (Task id, tracker ref, title, created-at, Export
status) keeps each Archive self-describing without the DB. It holds:

- every Session's ACP `session/update` stream, teed per Step as JSONL
  (implementation and every Critic — uniform across Harnesses), **and** a
  copy of the Harness's native transcript plus Subagent files at Step end
  where one exists;
- the **full, uncapped** stdout/stderr of every verify command, pre- and
  post-merge (the DB column stays a capped head+tail preview with a
  truncation marker, linking to the file);
- every resolved prompt sent to any Session;
- every operator input (steer, Reject reason, Accept, Pause/Resume,
  Close/Cancel with actor and reason — the missing ones become Facts).

The Archive is raw (unredacted). It **outlives the Task** — Delete leaves it —
and is removed only by an optional retention cap (`archive.retain.days`,
`archive.retain.maxTotalMB`, both off by default) enforced by a yielding
Scheduled Job that prunes oldest-terminal first and never touches a
non-terminal Task's Archive or one whose Export is pending/failed. Log views
read native JSONL first and fall back to the Archive copy.

**Export (optional).** On every terminal disposition — *done*, *cancelled*,
or Delete of a Task with at least one Attempt — Harmonic builds an **Export**:
a `.tar.gz` of the Archive plus `ticket.json`, `timeline.json`,
`operator-inputs.json`, `manifest.json` and a `README.md` summary, named
`<workspace>/<taskId>-<trackerRef?>-<disposition>-<ISO timestamp>.tar.gz`,
never overwritten. An Epic's Export carries its own Epic Attempts
(verification and Critic outputs), its timeline, and references to its
Members' Exports rather than their contents. Redaction runs **at Export
time** over a baseline pattern set plus configured patterns (Workspace
patterns are additive to global, per ADR-0037), replacing matches with
`[REDACTED:<pattern-id>]`.

Exports go to each configured **Export Destination** — a directory and/or an
S3-compatible bucket — independently. Config is global with per-Workspace
override (ADR-0022): `export.enabled`, `export.includeStates`,
`export.directory.path`, `export.s3.{endpoint, region, bucket, prefix,
forcePathStyle, accessKeyId, secretAccessKey}`, `export.redact.patterns`.
S3 credentials come from explicit keys if set, else the AWS default chain;
keys are masked in API responses and the UI.

An Export never blocks or reverts the disposition. Each attempt is a Fact on
the timeline; a failed Destination shows on the Ticket page, raises a toast,
and emits `export.failed` to Notification Channels, and a Scheduled Job
retries it 3× (5 min / 30 min / 2 h) before leaving it for a manual
**Export again**. The Ticket page offers **Export again** and **Download**;
Settings offers **Test Destination**. No backfill for pre-existing Tasks;
**Export again** on one yields an Export flagged `partial: true`.

**Git provenance (manifest `formatVersion` 2).** A Task Export's
`manifest.json` carries a `git` block so a consumer can compute and display a
diff without the repository's help: the Workspace `remoteUrl` (URL userinfo
stripped, then the same redaction as the rest of the Export), `baseBranch`,
`startCommit` (first Attempt), `endCommit` (the Merge commit when merged, else
the last Attempt's settled head), `mergeCommit`, and the same start/end pair
per Attempt. Every Attempt records `startOid` — `HEAD` of the directory it
works in — when it starts, in both isolation modes; direct mode had no start
commit before this. An unreadable `HEAD` stores null and never fails the
Attempt, and any git failure at Export time yields nulls, never a failed
Export. The Export carries no diff itself.

The Export hook hangs off the Task's terminal transition
(`attempt-settle.ts`) and the Delete path, not `postMerge`, which has five
call sites and does not see cancellation.

## Consequences

- Disk usage grows with work; the retention cap is the operator's lever.
- Archive writes are async file appends, off the DB write queue, so the
  event-loop guarantee holds; the prune job yields per ADR-0007.
- A local Archive contains unredacted secrets, as the Harness's own logs on
  that host already do; only Exports are redacted.
- New dependencies: a tar writer and an S3 client (or hand-rolled SigV4).
- Conversations are out of scope; the Archive is per-Task.

## Supersedes

ADR-0007, the paragraph "no tee-to-file, copy-on-dispatch, or retention
machinery exists…" only. The rest of ADR-0007 stands: the DB still never
stores the event stream.
