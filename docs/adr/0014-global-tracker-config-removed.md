# Global tracker config removed; tracker mirroring stays per-Workspace

Tracker enable/interval were global before per-Workspace mirroring (issue #45)
moved them onto the Workspace row; a vestigial `config.tracker` block lingered,
read by nothing but a one-time backfill. We considered reviving it as a
global-default-with-per-Workspace-override (the ADR-0012 inheritance pattern) so
tracking could be flipped fleet-wide, and rejected it. A global `enabled`
default would start **every** Workspace polling its repo on inherit, and any
Workspace without a `docs/agents/issue-tracker.md` would error every cycle, so
the safe shape is per-Workspace opt-in, which is exactly what we already have.
Tracker enable/interval therefore stay **Workspace-only** (no inherit
affordance), unlike the Task defaults and concurrency cap of ADR-0012, and the
dead global block is deleted outright.

## Considered options

- **Revive `config.tracker` as an inherit root (rejected).** Gives a fleet-wide
  toggle, but "inherit → on" makes every Workspace poll a repo that may have no
  tracker declaration, turning a convenience into a fleet of failing poll loops.
  The visibility that would make it safe (which Workspaces even *have* a tracker)
  is the Resolved Tracker surface, a reason to show resolution, not to inherit
  enablement.
- **Leave the vestigial block in place (rejected).** Dead config that still ships
  in the schema, config route, OpenAPI, and global settings UI: pure confusion
  for the next reader.
- **Delete it; tracker stays per-Workspace (chosen).**

## Consequences

- `config.tracker` removed from the config schema + defaults, the `PATCH /config`
  route schema (and the generated OpenAPI `ConfigPatch`), the web `AppConfig`
  type, and the global settings page's `TrackerFields`.
- The one-time `backfillDefaultWorkspace` shim still reads the legacy
  `tracker.{enabled,pollIntervalSeconds}` off the **raw stored JSON** (decoupled
  from the schema type via a small local legacy shape), so an instance upgrading
  across the gap still carries its old global setting onto the Default Workspace.
  It is marker-guarded (`trackerEnabledBackfilled`) and run-once, removable once
  all instances are known-migrated.
- No change to the live tracker fleet: pollers key entirely off
  `WorkspaceRow.trackerEnabled` / `trackerPollIntervalSeconds`.
