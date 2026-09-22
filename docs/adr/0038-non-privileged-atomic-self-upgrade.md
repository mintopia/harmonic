# Decision: Non-privileged atomic self-upgrade

Status: accepted
Date: 2026-09-22

Amends ADR-0030 (in-place self-upgrade) and ADR-0034 (supervised service).

## Context

ADR-0030's systemd upgrade path installs with `npm i -g` and exits so that
`Restart=always` starts the updated process. ADR-0034 binds the systemd unit to
an absolute CLI path. A service runs as an unprivileged user, so it cannot
reliably update the global npm installation. Even if it can install a new
global package, systemd restarts the absolute path that the unit recorded at
install time and can silently start old code.

Harmonic must update systemd-managed instances without privilege at upgrade
time. The service also drives agents as its workspace user, so giving it root
access only for upgrades would weaken the service boundary.

## Decision

### Systemd runs a stable application path

A systemd installation stores application releases under the data directory:

```
<dataDir>/app/
  versions/<version>/
  current -> versions/<version>
```

The root-run `harmonic install` command seeds the installed release in
`<dataDir>/app/versions/<version>`, creates `current`, and gives the service
user ownership of the application tree. The systemd unit starts the stable
path:

```
ExecStart=<node> <dataDir>/app/current/dist/cli.js serve <non-secret args>
```

`current` is the only path the unit uses to select a release. `versions` holds
complete releases and never becomes the unit's launch path.

### A systemd upgrade swaps the symlink

When a systemd-managed process upgrades, it installs the pinned new version in
`<dataDir>/app/versions/<new>`. It creates a replacement `current` symlink and
atomically renames it over the existing symlink. The process then verifies the
version through the `current` symlink target. It does not use `npm root -g` or
the global npm installation as evidence that the installed version is the code
systemd will launch.

After verification, the process calls `exit(0)`. `Restart=always` starts the
same `ExecStart` command again, which follows `current` to the new release.
The service user needs no root access during this operation.

### Other managed modes keep the relauncher

This decision changes only systemd Managed Mode. init.d and standalone Managed
Mode keep ADR-0030's relauncher. Neither has a supervisor that restarts the
process after a clean exit, and the service user cannot invoke a privileged
service restart.

### Existing installations need a privileged migration

An existing systemd unit records its old absolute CLI path. A non-root service
cannot rewrite its own system unit. Operators must run `harmonic install` once
with the required privilege to migrate an existing installation to the stable
`current` path before it can use non-privileged upgrades.

## Consequences

- Systemd upgrades install only into the service-user-owned application tree.
  They do not modify the global npm package.
- An upgrade changes one launch indirection atomically, so a systemd restart
  runs either the old release or the complete new release.
- The initial migration requires one privileged install re-run. Later upgrades
  do not require privilege.

## Supersedes

Supersedes ADR-0030's systemd `npm i -g` swap and ADR-0034's
`ExecStart=<abs-cli.js>` clause. ADR-0030's relauncher continues to apply to
init.d and standalone Managed Mode.
