# Run Keys: hard-delete at run end, startup sweep, hidden from listing

Status: ready

## Parent

QA session (2026-07-14)

## What to build

Run Keys (the ephemeral per-Run bearer tokens injected into Harnesses —
see CONTEXT.md) are currently soft-revoked when a Run finishes: the row
keeps `revokedAt` and lives forever, and `listKeys()` returns it, so the
API Keys UI fills up with dead machine credentials.

Change the Run Key lifecycle to hard deletion:

- When a Run finishes (any terminal state), delete its Run Key row
  outright instead of setting `revokedAt` (`runner.ts` currently calls
  `keys.revoke(run.id)` at run end).
- On startup, sweep: delete every `scope='run'` key whose Run is no
  longer `running`. This catches keys orphaned by a crash or restart
  (restart already fails interrupted runs, so the sweep is a simple
  join).
- `listKeys()` / `GET /keys` exclude `scope='run'` rows entirely
  (server-side, not a UI filter). "Keys" in the API and UI means
  operator-created API Keys only.

The Run itself (events, usage) remains the audit record; a dead key row
adds nothing, so no retention window or purge job is needed.

## Acceptance criteria

- [ ] A finished Run (completed, failed, or cancelled) has no Run Key row remaining
- [ ] Startup deletes `scope='run'` keys whose Run is not `running`
- [ ] `GET /keys` never returns `scope='run'` keys, even while a Run is active
- [ ] A deleted Run Key no longer authenticates REST or MCP requests
- [ ] Operator API Keys are unaffected by run-end deletion and the sweep
- [ ] Tests cover run-end deletion, the orphan sweep, and listing exclusion

## Blocked by

None.
