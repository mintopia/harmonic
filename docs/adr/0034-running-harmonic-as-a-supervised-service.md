# Decision: Running Harmonic as a supervised service

Status: accepted
Date: 2026-09-15
Amended 2026-09-16: the systemd unit sets `WorkingDirectory=<data-dir>`, and a
fresh install seeds no Workspace (first-run onboarding adds the first one) — see
"The systemd backend hands restart to the supervisor" and "No default Workspace
on a fresh install" below.
Amends ADR-0030 (the self-upgrade swap hands the restart to the supervisor
instead of the relauncher, in systemd Managed Mode) and ADR-0012 (service
install is a new distribution/tooling surface). Builds on the daemon launch
path (`harmonic start`/`stop`/`status`, the data-dir lock, the upgrade
relauncher).

**Amended by ADR-0038**: the systemd unit launches the stable
`<dataDir>/app/current` symlink rather than an absolute CLI path. Its
non-privileged upgrade installs and verifies code in the service-user-owned
application tree before atomically changing that symlink and exiting(0).

## Context

Harmonic already self-daemonizes: `harmonic start` spawns a detached `serve`,
writes a pidfile, and `stop`/`status` find it again; self-upgrade (ADR-0030)
restarts the process with a detached relauncher. What is missing is a way to
run Harmonic as a first-class OS service — starting on boot, controlled through
the host's service manager, surviving a host restart — installed once rather
than launched by hand.

The hosts differ. A traditional Linux box or VM runs **systemd**. Harmonic's
own home is a bespoke, isolated container where PID 1 is **s6-svscan**, systemd
is offline, there is no user D-Bus session, the agent runs unprivileged as the
workspace user, and persistent services (redis, mariadb) are installed as
**SysV `init.d`** scripts by a root-run provision hook. A single `install`
command has to do the right thing on both without the operator choosing a
mechanism.

## One command, an auto-detected backend

`harmonic install` and `harmonic uninstall` are the surface. `install` detects
the best available backend in a fixed ladder:

1. **root + systemd running** → a systemd **system** unit.
2. **root + init.d** (no systemd) → a SysV **`/etc/init.d/harmonic`** script
   registered with `update-rc.d`.
3. **user systemd usable** (a running user instance, `XDG_RUNTIME_DIR` set,
   linger available) → a systemd **user** unit.
4. **none** → no OS service; start the self-managed daemon and **print** the
   `harmonic start …` line to add to the host's boot hook.

Everything sits behind a `ServiceManager` seam — one interface
(`install`/`uninstall`/`start`/`stop`/`restart`/`status`/`isInstalled`) with a
systemd implementation and an init.d implementation. This is Linux only; on
macOS or Windows the seam throws a clear "only systemd/init.d supported" error
rather than misbehaving. launchd and a Windows backend can slot in later; they
are not built now.

Every backend runs the same thing under the hood — `harmonic serve`, or the
existing `harmonic start` daemon — never a new server mode.

## The init.d backend wraps the existing daemon

`/etc/init.d/harmonic` is a thin LSB script that shells out to Harmonic's own
daemon verbs as the target user: `start)` runs
`runuser -u <user> -- harmonic start --data-dir <dir>`, `stop)` runs
`harmonic stop`, `status)` runs `harmonic status`, and `restart)` is stop then
start. It is installed and registered by root at provision time, but Harmonic
itself runs as a non-root **`--user`** (default `$SUDO_USER`, else `workspace`);
running as root is allowed but warned against, since the agents it drives run as
the workspace user.

Wrapping the daemon rather than driving `serve` through `start-stop-daemon`
(redis's pattern) is deliberate. Harmonic already owns a robust
self-daemonize + single-instance lock + upgrade relauncher; the relauncher
rewrites the data-dir pidfile with the new PID, so `service harmonic stop` keeps
finding the live process **across a self-upgrade**. A separate
`start-stop-daemon` pidfile would go stale the moment the relauncher swapped the
process, breaking `stop`/`status` after every upgrade.

## The systemd backend hands restart to the supervisor

The systemd unit runs `ExecStart=<abs-node> <abs-cli.js> serve <non-secret
args>` (an absolute command, because a unit's PATH is minimal), with
`WorkingDirectory=<data-dir>`, `Restart=always`, a generous `TimeoutStopSec`
(the SIGTERM path waits ~40s for the OTLP flush), and
`Environment=HARMONIC_MANAGED_BY=systemd`. `WorkingDirectory` is set because a
systemd service with no `WorkingDirectory=` runs with cwd `/`; the data dir
always exists and is writable by the service user, so it is the safe anchor.
Non-secret
flags (`--port`/`--host`/`--data-dir`/`--otel-*`) bake into `ExecStart`; a
password is written **only** to a `0600` EnvironmentFile when `--password` is
passed, otherwise the already-persisted password is used and no secret touches
disk.

Because systemd supervises the process, self-upgrade in this mode does **not**
spawn the relauncher: it installs the new version, verifies it, and exits(0);
`Restart=always` reboots onto the new binary. The running server reads
`HARMONIC_MANAGED_BY` to choose this path. In init.d and standalone Managed
Mode there is no such supervisor — a SysV service is not restarted on exit, and
the unprivileged process cannot invoke a root `service restart` — so the
relauncher stays exactly as ADR-0030 defined it.

## No default Workspace on a fresh install

Boot seeds no Workspace. Earlier, a fresh database auto-created a "Default"
Workspace whose working directory came from `$CWD` (the serve process's cwd).
Under a systemd service that resolves to `/`, and the per-Workspace filesystem
watcher then tried to watch the entire root recursively — flooding the logs with
`EACCES` as it walked into `/sys`. A fresh install now starts with zero
Workspaces; the web UI's first-run onboarding prompts the operator to add one,
its directory picker defaulting to the run-as user's home. The watcher is
hardened independently: it never follows symlinks and refuses a filesystem root
as a Workspace working directory.

## Command routing and uninstall

When a systemd service is installed, `harmonic start`/`stop`/`restart` delegate
to `systemctl [--user] … harmonic` and `status` reports the unit's state — one
mental model whether the operator types the CLI verb or `systemctl`. Under
init.d the verbs delegate the same way, to `service harmonic …`, so a supervised
instance is always driven through its supervisor. The init.d script's own
invocation of the daemon is marked with `HARMONIC_INITD_SERVICE`, which the CLI
reads to run the verb directly and avoid recursing back into `service`. With no
service installed the verbs behave exactly as before.

`harmonic uninstall` stops the service, deregisters it (`systemctl disable` +
`daemon-reload`, or `update-rc.d -f harmonic remove`), and removes the unit or
script. It **never** touches the data dir — the DB, worktrees, and settings all
survive — and it leaves any `linger` setting alone, since other user services
may rely on it.

## Consequences

- Two supervised Managed Modes join the existing standalone daemon. The upgrade
  path now branches on `HARMONIC_MANAGED_BY`: supervisor-restart under systemd,
  relauncher everywhere else.
- The init.d backend is the mechanism for Harmonic's own container home, invoked
  from the root provision hook, dropping to the workspace user.
- `install`/`uninstall` are the first commands that mutate host state outside the
  data dir. They are Linux-gated at the seam and no-op cleanly where no backend
  fits (rung 4), so nothing is left half-registered.
- Testing rides on the seam: a mock command runner exercises backend detection,
  unit/script generation, `--user` resolution, and the upgrade-branch choice
  without touching the real host.

## Supersedes

Nothing. Amends ADR-0030 (supervised restart supersedes the relauncher in
systemd mode; the relauncher remains for init.d and standalone) and ADR-0012
(service install as a distribution surface). Builds on ADR-0007 (schema-sync,
crash recovery — a restart is expected), ADR-0009 (single-instance data-dir
lock).
