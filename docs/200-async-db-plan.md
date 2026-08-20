# #200 — Full async DB migration (libsql) + event-loop guarantee

**Goal:** nothing — slow query or background loop — can block the event loop and freeze the UI. Achieved by making DB access fully async and giving #200 ownership of the "nothing blocks the loop" guarantee.

## Decisions (locked via grill)

| Decision | Choice | Why |
|---|---|---|
| Async mechanism | **libsql** (`@libsql/client` `file:`, `drizzle-orm/libsql`) | Native-async, first-class drizzle async adapter; engine swap from sync better-sqlite3. |
| Migration | **Incremental expand-contract**, **per-store/domain-module** batches | Hundreds of sync call sites; keep CI green batch to batch. |
| Writes | **Single-writer async queue**; **reads concurrent** (WAL) | Preserves the single-writer invariant the coordination spine assumes; classify call sites read vs write. |
| Atomicity | Unchanged — **unique-index CAS** (INSERT + catch unique-violation) | Correctness is DB-enforced, not synchrony-enforced; survives async. Only **6** `.transaction()` sites, converted to async tx run as exclusive write-queue units. |
| Spike? | **No** — commit and fix libsql incompatibilities as they surface | (User call.) Compat validation folded into the Expand ticket instead. |
| #200 also owns | **event-loop watchdog · loops-must-yield · heavy-reads-off-thread · per-query timeouts** | The general guarantee, beyond the driver swap. |

## Key risks (no spike, so watch these in Expand)

- libsql vs better-sqlite3 behavioural deltas: the **FK off/on boot dance** + `foreign_key_check`, `.pragma()` calls, WAL semantics, drizzle-libsql **async transaction** API.
- Async contagion: every `.get/.all/.run` → `await`; propagates through stores → routes → runner, and **the entire vitest suite** (currently sync DB calls).
- Read/write classification burden at every call site (chosen for read concurrency).

## Ticket structure (expand-contract wide refactor)

1. **ADR** — async libsql + single-writer model (write first; records the driver swap + concurrency model).
2. **Expand** — add async libsql `Db` + read/write queue facade **alongside** the sync `Db`; port boot (WAL/FK/`foreign_key_check`) to libsql; prove compat. Blocked by: ADR. *Sync Db stays.*
3. **Per-store batches** (each blocked by Expand; each keeps CI green): RunStore · TaskService · WorkContextLeaseStore · RunFactStore/run-facts · run-cascade · workspaces · conversations · sessions · turn-queue · guardrail/landing stores · config-store. (~8–12 tickets; tests migrate with each.)
4. **Routes async** — flip server route handlers to await. Blocked by: the store batches its routes touch.
5. **Runner async** — flip runner / auto-drive / coordinators. Blocked by: the store batches.
6. **Contract** — delete the sync better-sqlite3 `Db` path + dependency once no caller remains. Blocked by: Routes + Runner.
7. **Guarantee tickets** (parallel to the migration): event-loop **watchdog** · **loops-must-yield** helper+rule · **per-query timeouts** · **heavy-reads-off-thread** (largely free once async).

**Magnitude:** ~18–22 tickets; a multi-week migration touching most of the codebase and the whole test suite. Expand + ADR are the safe starting frontier.
