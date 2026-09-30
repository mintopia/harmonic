# Design: Task Archive and Export

Binding decision record: ADR-0044. This document covers the technical shape.

## Context

- The DB is disposable (ADR-0007 clean-break) and `tasks.id` is an
  autoincrement integer reused after a recreate.
- The event loop must never be frozen (ADR-0007, AGENTS.md): no synchronous
  bulk work, loops yield via `forEachYielding` / `yieldToEventLoop`.
- `postMerge` has five call sites and never sees cancellation; the Task's
  terminal transition in `attempt-settle.ts` and the Delete path are the only
  complete trigger points.
- Settings live in `settings.yaml`, global with per-Workspace sparse override
  (ADR-0022); additive overlays follow ADR-0037.

## Goals / Non-Goals

- Goals: complete, Harmonic-owned record per Task; survives Harness log
  pruning, Task Delete, and DB recreate; optional shipped Export with
  redaction; failures visible, never blocking.
- Non-Goals: Conversations; backfill; redacting the local Archive; storing any
  stream in the DB; cross-instance deduplication of Exports.

## Decisions

### Archive layout

```
<dataDir>/archive/<workspace>/<taskId>-<archiveId>/
  archive.json                       # taskId, archiveId, trackerRef, title,
                                     # workspace, createdAt, dispositions[],
                                     # exports[] (per-Destination status)
  operator-inputs.jsonl              # append-only
  attempts/<n>/
    implementation/
      prompt.md
      acp.jsonl                      # ACP session/update tee
      native/                        # native JSONL + Subagent files
    verification/<stage>/<step-id>/
      prompt.md                      # Critics only
      output.log                     # verify commands: full stdout+stderr
      acp.jsonl                      # Critics only
      native/                        # Critics only
```

- `archiveId` is a UUID column on `tasks`, set at creation. The directory name
  keeps `taskId` for human browsing; `archiveId` guarantees uniqueness.
- `archive.json` is rewritten atomically (write temp + rename).
- Stream writes use async append handles per Step, opened at Step start and
  closed at Step end; no DB write queue involvement.
- Native copy runs at Step end (and in crash recovery for Steps that were
  mid-flight), copying the resolved `transcript_path` plus Subagent files.
  Copy is streamed, never read whole into memory.

### Verify output

The spawned process's merged stdout/stderr is piped both to the Archive
`output.log` (uncapped) and the existing in-memory buffer. The DB
`verification_attempts.output` preview becomes head + tail within the existing
200k cap with an explicit `…[truncated N chars]…` marker.

### Log view fallback

`readTranscriptLog` resolves native path first; if absent or unreadable it
reads `acp.jsonl` / `native/` from the Archive. The 2 MiB / 2000-event view
cap is a view concern only; Exports always include full files.

### Export pipeline

1. Trigger: terminal transition (`done`, `cancelled`) in `attempt-settle.ts`
   and the Delete path (only if ≥1 Attempt). Enqueued, never awaited by the
   transition.
2. Build: stream Archive files through a redaction transform into a gzipped
   tar in `<dataDir>/archive/.staging/`, plus generated `ticket.json`,
   `timeline.json`, `operator-inputs.json`, `manifest.json`, `README.md`.
   Timeline and ticket are captured from the DB **at trigger time** so a
   subsequent Delete cannot lose them.
3. Deliver: to each enabled Destination independently; per-Destination status
   recorded in `archive.json` and as a timeline Fact.
4. Retry: a Scheduled Job retries failed Destinations at 5 min, 30 min, 2 h,
   then stops; manual **Export again** rebuilds and redelivers.
5. The staged tarball is deleted once every Destination has succeeded or
   exhausted retries.

Epic Export contents: Epic Attempts (verification + Critic outputs),
Epic timeline, and a `members` list in `manifest.json` of Member Export
filenames and statuses at build time.

### Redaction

- Applied only while building an Export (and Download).
- Pattern list = baseline set ∪ global `export.redact.patterns` ∪ Workspace
  patterns (additive; a Workspace cannot remove a global or baseline pattern).
- Each pattern has an `id` and a regex; matches become
  `[REDACTED:<id>]`. `manifest.json` records per-pattern match counts.
- Baseline ids: `aws-access-key`, `aws-secret-key`, `github-token`,
  `gitlab-token`, `bearer`, `sk-api-key`.
- Streaming redaction must handle matches spanning chunk boundaries (overlap
  window ≥ longest plausible match).

### Configuration

```yaml
archive:
  retain:
    days: null          # off
    maxTotalMB: null    # off
export:
  enabled: false
  includeStates: [done, cancelled, deleted]
  directory:
    path: null
  s3:
    endpoint: null
    region: null
    bucket: null
    prefix: ""
    forcePathStyle: false
    accessKeyId: null     # masked in API/UI
    secretAccessKey: null # masked in API/UI
  redact:
    patterns: []          # [{ id, regex }]
```

Global with per-Workspace override for every key; `redact.patterns` merges
additively. S3 credentials: explicit keys if both set, else AWS default
credential chain.

### Retention prune

Scheduled Job, yields between Archives. Eligible: Archive whose Task is
terminal or deleted AND has no Export pending/failed (or Export disabled).
Order oldest terminal disposition first; apply `days` then `maxTotalMB`.
Never touches `.staging/` entries in use.

### Surfacing

- Ticket page Export panel: per-Destination status, last attempt time, error,
  **Export again**, **Download**.
- Failure: toast to all connected UI clients; `export.failed` event to
  Notification Channels. Success: timeline Fact only.
- Settings: "Archive & Export" section with **Test Destination** (writes and
  deletes a probe object).

## Risks / Trade-offs

- Disk growth → retention cap, off by default; documented.
- Local Archive holds unredacted secrets → same exposure as the Harness's own
  logs on that host; only Exports leave the host.
- Redaction is best-effort regex; documented as such.
- S3 client dependency size → evaluate `@aws-sdk/client-s3` vs minimal SigV4.

## Open Questions

None — all resolved in the grilling session (see ADR-0044).
