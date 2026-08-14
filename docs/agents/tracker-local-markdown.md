# Tracker adapter: local-markdown

A repo with no GitHub/GitLab tracker keeps its tickets as markdown files in the
**mattpocock** format (the `/to-tickets` and `/to-spec` skills). The adapter
reads them; it never writes. Select it from `docs/agents/issue-tracker.md`:

```
# Issue tracker: local-markdown

Path: .scratch
```

`Path:` is optional (default `.scratch`, resolved relative to the repo unless
absolute) — the whole config surface.

## Layout

`Path:` names the ticket root. The adapter finds the ticket files by trying, in
order:

1. `<root>/issues/*.md`
2. `<root>/*.md` (a flat ticket dir)
3. the single feature dir `<root>/<slug>/issues/*.md`

`/to-tickets` writes `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, so with the
default `Path: .scratch` case 3 applies. A repo can hold **several** feature
specs at once (`.scratch/<slug-a>/`, `.scratch/<slug-b>/`) — they all show,
no `Path:` needed.

## Ids across features

Ids are minted from the filename prefix (`03-foo.md` → 3), so different features
would collide (both have an `01-`). Each feature gets its own **id namespace**:
feature *N* (features sorted by name) uses `N * 10000 + <local NN>`. The first
feature is `base 0`, so a single-feature repo just sees `01 → 1`, `02 → 2`, …
`**Blocked by:** 01, 02` is feature-local and resolved within the feature before
the offset is applied. A feature is capped at 9999 tickets. Ids are stable per
file, and features sort by name, so adding a later-sorting feature never
renumbers existing tickets.

## Each spec is a Map

Every feature's sibling `spec.md` (from `/to-spec`) is surfaced as a wayfinder
**Map** — `isMap: true`, local id `0` (so `base 0`, `base + 10000`, …), title
from its `# Spec: …` heading (the `Spec:` prefix stripped). That feature's issues
`parent` onto its own Map, so the board rolls each spec's tickets up under it,
exactly as a GitHub `wayfinder:map` issue with child issues would. A feature with
no `spec.md` has no Map, and its issues' `parent` is null.

## Ticket file convention

One `<NN>-<slug>.md` file per ticket. The **id is minted from the filename
prefix** (`03-adapter.md` → 3); files with no leading integer are skipped. Ids are
ticket-local, so the `**Blocked by:** 01, 02` prose resolves directly against them.

```markdown
# 03 — Ticket title

**What to build:** the end-to-end behaviour, from the user's perspective.

**Blocked by:** 01, 02

**Status:** ready-for-agent

- [ ] Acceptance criterion
```

- **Title** comes from the `# <NN> — <Title>` heading (the `NN —` prefix is
  stripped); the filename slug is the fallback. The heading is stripped from the
  ticket body.
- **State** is `closed` when **either** signal says done — either alone is
  enough: every acceptance-criteria checkbox is ticked (`- [x]`/`- [X]`), **or**
  `**Status:**` is a done word (`done`/`closed`/`complete`/`merged`/`shipped`).
  So an agent may tick the boxes, set `Status: done`, or both. A ticket with no
  checkboxes rests entirely on its Status. The status text is kept as a label
  (so `ready-for-agent` surfaces as a label).
- **Relationships** come from `**Blocked by:**` (a list of ids, or "None …").
  `scan` synthesises the directional graph: a `blockedBy` on one side fills the
  reverse `blocking` on the other. Dangling refs are dropped. There is no
  `parent` in this format, so `parent` is always null and `isMap` is always false.

## Read-only

The mattpocock format carries no assignee or closed field, so Harmonic's
reservation/accept writes have nowhere to land: `claim`, `release`, and `close`
**no-op**. Harmonic still tracks the reservation and accept in its own DB — they
just don't persist back to the file. `whoami` returns the ambient git identity
(`user.email`, else `user.name`, else `harmonic`) for the foreign-assignee
filter, which is a pass-through since no assignee is ever written. There is no PR
concept, so no `openPR`.
