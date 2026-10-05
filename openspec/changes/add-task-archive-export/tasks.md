## 1. Archive foundation

- [x] 1.1 Add `tasks.archive_id` (UUID, set at creation) to `src/db/schema.ts` and regenerate the baseline
- [x] 1.2 Archive path resolver and `archive.json` writer (atomic temp+rename)
- [x] 1.3 Real-execution tests asserting on-disk layout (no mocked fs)

## 2. Transcript capture

- [x] 2.1 Tee ACP `session/update` per Step to `acp.jsonl` for implementation Sessions
- [x] 2.2 Same for Critic Sessions
- [x] 2.3 Copy native transcript + Subagent files to `native/` at Step end; re-copy in crash recovery
- [x] 2.4 Write resolved `prompt.md` for every prompt sent
- [x] 2.5 Log routes fall back to the Archive when the native transcript is missing

## 3. Verify output and operator inputs

- [x] 3.1 Pipe full verify-command stdout/stderr to `output.log` (pre- and post-merge)
- [x] 3.2 DB preview becomes head+tail with truncation marker
- [x] 3.3 Record Accept, Close/Cancel (actor, reason) as Facts
- [x] 3.4 Append every operator input to `operator-inputs.jsonl`

## 4. Export builder

- [x] 4.1 Config schema + baseline defaults + per-Workspace override + secret masking
- [x] 4.2 Streaming redaction transform (baseline + additive patterns, boundary-safe)
- [x] 4.3 Tarball builder (manifest, README, ticket, timeline, operator inputs, Archive files)
- [x] 4.4 Epic Export variant with Member references
- [x] 4.5 Triggers on `done`, `cancelled`, and Delete (≥1 Attempt); snapshot ticket/timeline at trigger

## 5. Destinations and retries

- [x] 5.1 Directory Destination
- [x] 5.2 S3-compatible Destination (explicit keys or default chain, path-style option)
- [x] 5.3 Per-Destination status, timeline Facts, retry Scheduled Job (5m/30m/2h)
- [x] 5.4 `export.failed` Notification Channel event + UI toast
- [x] 5.5 Test Destination endpoint

## 6. Retention

- [x] 6.1 Yielding prune Scheduled Job honouring `days` and `maxTotalMB` and eligibility rules

## 7. UI (mockup first)

- [x] 7.1 Mockup: Ticket-page Export panel and Settings "Archive & Export" section
- [x] 7.2 Ticket-page Export panel (status, Export again, Download)
- [x] 7.3 Settings section including redaction patterns and Test Destination

## 8. Finish

- [x] 8.1 User docs for the UI-exposed features
- [ ] 8.2 `npm run typecheck`, `npm run lint`, `npm test`
- [ ] 8.3 `/no-comments`
