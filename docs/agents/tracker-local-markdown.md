# Tracker adapter: local-markdown

A repo with no GitHub/GitLab tracker keeps its tickets as markdown files. Nothing
is native — the adapter *is* the tracker. Select it from
`docs/agents/issue-tracker.md`:

```
# Issue tracker: local-markdown

Path: .scratch
```

`Path:` is optional (default `.scratch`, resolved relative to the repo unless
absolute) — the whole config surface.

## Ticket file convention

One `<id>-<slug>.md` file per ticket under the configured dir. The **id is minted
from the filename prefix** (`0037-adapter.md` → 37); files with no leading integer
are skipped. Referential integrity of edges is the adapter's job — nothing
validates a dangling reference (it's dropped on read).

```markdown
---
title: local-markdown tracker adapter
state: open            # open | closed
createdAt: 2026-08-08T10:00:00Z
labels: [ready-for-agent, wayfinder:map]
assignees: []
parent: 19
blockedBy: [29]
blocking: []
---

Body markdown here.
```

- **Relationships are convention.** Declare `parent`, `blockedBy`, `blocking` (id
  or id-list) on either end of an edge. `scan` synthesises the directional graph:
  a `blockedBy` on one side fills the reverse `blocking` on the other.
- **Map-ness is the `wayfinder:map` label** (same as GitHub).
- **Comments** are appended after a `<!-- comments -->` marker as
  `### <author> · <timestamp>` blocks. `close`'s accept comment lands here.

## Writes

`claim`/`release` add/remove the ambient identity (git `user.email`, else
`user.name`, else `harmonic`) in `assignees`. `close` sets `state: closed` +
`closedAt` and appends the accept comment. Each is one file write; committing to
git is the caller's job. There is no PR concept, so no `openPR`.
