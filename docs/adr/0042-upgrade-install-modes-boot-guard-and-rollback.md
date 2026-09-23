# Decision: Upgrade install modes, boot guard, and rollback

Status: accepted
Date: 2026-09-23

Amends ADR-0041 (non-privileged atomic self-upgrade).

## Context

ADR-0041 flips `app/current` to the new version and verifies through it
afterwards. Nothing flips it back when the new release cannot boot: systemd's
`Restart=always` retries until `StartLimitBurst` and leaves the unit failed.
Non-systemd upgrades run `npm i -g` as an unprivileged user, which fails with
EACCES on a root-owned prefix and gives npx users a global install they never
asked for. Under an external supervisor (pm2, Docker, a hand-written unit) the
persisted `upgrading` phase clears only when the running version equals the
target, so every boot reinstalls and exits forever. A foreground `harmonic
serve` silently becomes a background daemon. `app/versions/` is never pruned.

## Decision

**Install mode is detected once at boot.**

- `systemd`: `HARMONIC_MANAGED_BY=systemd` and the CLI resolves under
  `<dataDir>/app/current`.
- `initd`: `HARMONIC_MANAGED_BY=initd` and the same path condition.
- `migration-required`: managed, but the CLI resolves elsewhere.
- `external`: everything else, including npx, npm-global, a source checkout,
  pm2, Docker and a foreground `serve`.

Harmonic self-upgrades only `systemd` and `initd`. For `external` it shows the
upgrade command for that install kind instead of offering an upgrade, and arming
is rejected.

**Stage, verify, then flip.**

1. Install the release into `versions/<v>` through a staging directory.
2. Verify it in place, before `current` changes:
   - `package.json` version equals the target;
   - `node dist/cli.js --version` succeeds;
   - a child process can `import()` `dist/cli-serve.js`.
3. Snapshot the database with `VACUUM INTO app/pre-<v>.db`.
4. Write `app/pending.json` with the target, the previous version and the
   snapshot path.
5. Flip `current` atomically: create a temporary symlink, then `rename` it over
   `current`.

A failure at any step leaves `current` untouched.

**Cancel** is honoured only up to the flip. It can stop the swap at the
install/verify/await-idle boundaries (steps 1-4), but once step 5 (the flip)
has started it is rejected — the swap runs to completion instead of racing
it. If `waitForIdle` times out with work still running, the swap aborts the
same way, before the flip, and returns to `armed` rather than `unarmed`, so
the next idle window retries the same target instead of losing the offer.

**Boot guard.** `app/boot-guard.cjs` is dependency-free and unversioned. It runs
before every start: as `ExecStartPre=-` in the systemd unit, from the init.d
script, and from the relauncher.

- While a version is pending, the guard counts its boots.
- On the fourth boot it flips `current` back to `previous`. It moves the live
  `harmonic.db` (and any `-wal`/`-shm`) aside into
  `app/rolled-back/<version>-<timestamp>/` rather than deleting them, copies
  the pre-upgrade snapshot into place via a tmp-file-plus-fsync-plus-rename
  (durable across a power loss), and moves the originals back if that copy
  fails. It then writes `app/rollback.json` — itself fsynced, recording
  whether the database was restored (`databaseRestored`) and where the
  preserved copy landed (`preservedDatabaseDir`) — and deletes `pending.json`.
- A release that never reaches `listen` counts as a failed boot too: an
  out-of-process startup watcher (`startup-watcher.cjs`, spawned non-detached
  in the same cgroup so systemd's `KillMode` still reaps it) SIGKILLs the
  server once it goes `HARMONIC_STARTUP_DEADLINE_MS` (120s default) without
  touching `app/startup-progress`, which the server touches at boot and after
  each migration step — so a slow-but-healthy boot isn't killed, and (unlike
  an in-process timer) neither is a synchronous event-loop hang missed. The
  init.d relauncher has no kill deadline of its own for this: it just waits
  for `pending.json` to clear or the child to exit, under an overall safety
  cap (`HARMONIC_RELAUNCHER_OVERALL_DEADLINE_MS`, 30 minutes default) that
  only exists for the case nothing else ever kills a wedged child; if it
  fires, the relauncher kills that child and stops instead of starting
  another round against a process it can't be sure has died.
- After `listen` succeeds, the new process clears `pending.json`. Only then does
  it copy its own guard over `app/boot-guard.cjs`. A pending boot therefore
  always runs a guard shipped by a release that has already booted.

A rollback discards only what the never-healthy release wrote, plus anything the
old process wrote between the snapshot and its exit — and even that is preserved
on disk, not deleted, in case an operator needs it back.

Units gain `RestartSec=2`, `StartLimitIntervalSec=120` and `StartLimitBurst=10`.
Together these allow the guard to act before systemd gives up.

**`harmonic install` and init.d stay idempotent.** init.d's `start` checks
`status` first and skips the guard and relaunch entirely when Harmonic is
already running. `harmonic install` restarts an already-running service
instead of leaving the old process up after rewriting its unit, and refuses
outright — rather than guessing — when an explicitly-flagged existing unit
can't be fully parsed.

**One attempt per arming.** A boot can find the persisted phase `upgrading` for
a version other than the running one. It then:

- records phase `failed`, taking the reason from `rollback.json` or else "restarted
  on previous version";
- restores the Auto-Runner;
- never reinstalls.

Retrying means arming again.

**Pruning.** Keep the `current`, `previous` and pending versions. Delete every
other `versions/*` entry, leftover `*.tgz` files and stale snapshots. Pruning
runs only when no upgrade is in flight.

## Consequences

- Existing system-level units and init.d scripts get the guard only after one
  `sudo harmonic install`. Until then they keep upgrading themselves in place,
  protected by verification before the flip, and the banner says automatic
  rollback is off.
  User-level units are rewritten in place.
- npx, npm-global, pm2 and Docker users upgrade by hand, with the exact command
  shown in the UI.
- A rollback restores the pre-upgrade database. Anything written after the
  snapshot is not restored, but the discarded live files are preserved under
  `app/rolled-back/`, not deleted. The rollback notice says so and names the
  preserved copy.
- Each upgrade keeps an extra copy of the database until pruning removes it.

## Supersedes

Two clauses of ADR-0041: "verify through `current` after the flip" and "other
managed modes keep the relauncher". init.d moves to the `app/` layout. A
standalone or foreground process no longer self-upgrades.
