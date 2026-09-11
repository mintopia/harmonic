# Decision: In-place self-upgrade for packaged instances

Status: accepted
Date: 2026-09-10
Implementation pending (epic to follow). Introduces the Update Check Scheduled
Job (ADR-0010), the Update Banner (ADR-0011), and a self-restart primitive on
top of the daemon launch path (ADR-0012). Amends ADR-0006 (a restart-killed
Conversation becomes resumable).

## Context

Harmonic ships as the npm package `@mintopia/harmonic` (ADR-0012), released by
release-please (ADR-0013). An operator running a packaged instance has no
in-product signal that a newer version exists, and no way to upgrade without
manually stopping the daemon, running npm, and starting it again — with no
in-product sense of when that is safe. We want an in-product update checker and a
one-click upgrade that never interrupts running work and never loses data.

## Distribution Mode gates the whole feature

An instance runs one of two ways: **packaged** (a global npm install, upgradable
in place) or **source** (a git checkout, developer or self-hosted). Detected at
boot by whether a `.git` directory sits at the app root. Only *packaged* mode
runs the Update Check and shows the Update Banner; *source* mode suppresses both.
Harmonic will not offer an upgrade it cannot cleanly perform, and a checkout is
upgraded by its owner with git, not by the product.

## The Update Check is a Scheduled Job

A Scheduled Job (ADR-0010) queries the npm registry for the `@mintopia/harmonic`
`latest` dist-tag, compares it by semver against the running version, and records
an available update only when the published version is strictly greater. Stable
releases only — pre-release tags are ignored. It runs on boot and hourly, and
surfaces on the Operations page like every other Scheduled Job (interval / last
run / next run / result). A failed check is a recorded Job failure, never fatal.

## The Update Banner

An instance-global banner at the top of every board (ADR-0011). **Three states**:
*available* (Upgrade / Dismiss), *armed* (the operator chose to upgrade — it will
restart once the instance is idle; Cancel), and *upgrading* (the swap is under
way). **Dismiss is per-version**: a newer published version re-raises it, and
there is no permanent silence — that would hide security fixes. Dismiss and arm
are instance-wide, never per-Workspace: one binary is being upgraded, so a
per-Workspace state would be incoherent.

## Arming quiesces the instance; the swap fires at idle

Clicking Upgrade pins the **exact offered version** (npm `latest` may move again
before idle is reached; the operator consented to a specific version) and
**persists the armed intent in the DB**, so a crash before it fires does not lose
it. Arming turns the Auto-Runner **master switch off** and blocks manual
launches, so in-flight work drains rather than replenishing — without this the
instance could never reach idle.

**Idle** is: zero running Attempts (Task and Epic), no in-flight Operation
(merge / integrate), and no Conversation mid-turn. A running Attempt or Operation
is a **hard block**. A Conversation is **never force-killed**: the swap waits for
a between-turns gap and shows a "waiting for agent before updating" notice, then
proceeds once no turn is in flight. The operator resumes those Conversations
after the restart (see Consequences).

**Cancel** at any point before the swap un-arms, clears the persisted intent, and
**restores the master switch to its pre-arm value**.

## The swap: install, then hand off to a relauncher

When idle is reached:

1. `npm i -g @mintopia/harmonic@<pinned>`.
2. Verify the installed version equals the pinned target.
3. Spawn a detached **relauncher** — a short-lived helper that watches the
   data-dir lock and launches the new `serve` once the lock is free.
4. The running process releases the lock and exits.
5. The relauncher, seeing the lock released, boots the new version and exits.

The relauncher decouples the respawn from the dying process, avoiding a self-spawn
race on the single-instance data-dir lock (ADR-0009). All on-disk state —
`harmonic.db` and the worktrees under the data dir — is untouched; schema-sync
converges the DB forward on boot (ADR-0007), so no migration step is needed.

## Failure handling

If `npm i -g` fails, or the installed version does not match the target, the swap
**aborts before the old process exits**: un-arm, restore the master switch,
re-raise the banner, and notify with the error. The instance keeps running the
current version. There is **no automatic rollback** of a version that installs
but then fails to boot — that needs a supervisor Harmonic does not have. v1
accepts manual recovery for that case and mitigates it by verifying the install
before handing off. A boot-time reconcile completes an armed-and-idle upgrade
that a crash interrupted.

## Consequences

- A new self-restart capability: Harmonic can relaunch itself, previously a
  purely manual `stop`/`start`. Boot-time crash recovery of orphaned running
  Attempts and Conversations (ADR-0007) already treats a restart as expected, so
  the blast radius is bounded.
- Restart ends active Conversations. This ADR **depends on** making a
  restart-killed Conversation **resumable** (cold-resume with a token-cost
  warning), which amends ADR-0006's "cannot resume" clause; it is a **blocking
  sibling ticket** in the implementation epic, not a sub-task of the banner.
- The Update Check adds one outbound npm-registry call per interval — the first
  network dependency in the Scheduled-Job set.
- Armed state is new persisted instance lifecycle that survives restart and must
  be reconciled on boot (armed + idle ⇒ proceed).

## Supersedes

Nothing. Amends ADR-0006 (a restart-killed Conversation becomes resumable, not
terminal). Builds on ADR-0007 (schema-sync, crash recovery), ADR-0009
(single-instance data-dir lock, master switch), ADR-0010 (Scheduled Jobs,
Operations), ADR-0011 (web and banner conventions), ADR-0012 (npm distribution),
ADR-0013 (release-please).
