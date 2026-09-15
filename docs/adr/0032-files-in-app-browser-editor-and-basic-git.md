# Files: in-app file browser, editor, and basic git

Status: accepted
Date: 2026-09-14

## Context

Harmonic had no way to look at or edit the files in a Workspace's Working
Directory from the web UI. The existing surfaces are read-only glances at agent
work (Activity, ADR-0026) and at orchestration (Operations, ADR-0024); the only
filesystem endpoint, `GET /api/fs` (issue #62), lists immediate child
directories one level deep — no files, no root restriction. Reviewing or
hand-fixing a repo meant leaving Harmonic for a terminal or a separate IDE.

We want a simple web IDE scoped to one Workspace: a directory tree with git
status colouring, a tabbed editor with save, previews for non-text files, and
basic git actions — without turning it into a full-fidelity IDE or a
shared-history git client.

## Decision

- **New workspace-scoped `files` view** (rail label "Files"), rooted at the
  active Workspace's Working Directory — one repo root per view. Per-task
  worktrees stay in the Operations and diff surfaces; the Files view does not
  fold them in.
- **CodeMirror 6, not Monaco.** Lighter, tree-shakeable, clean Vite
  integration, and a fit for the restrained aesthetic and the "simple" goal.
  Monaco's full-IDE weight (workers, bundle, minimap) is not worth it here. This
  is the web app's editor engine and carries lock-in the way `@dnd-kit` does
  (ADR-0031).
- **Confined-write security boundary.** All reads and writes are confined to the
  Working Directory: `..` traversal and symlink escape are rejected, the session
  is operator-only (matching `/api/fs`), and every write is logged (ADR-0010 —
  an action with no log is a defect). A browser-driven arbitrary-path file
  writer is deliberately not built.
- **API (Fastify + zod, OpenAPI regenerated per ADR-0011).** Extend `/api/fs` to
  include files (lazy per-dir, capped/paginated). Add `GET /api/fs/file`
  (text + metadata), `GET /api/fs/raw` (bytes for image/audio preview and
  download), `PUT /api/fs/file` (save), and create / rename / delete / move.
  Git: `GET /api/git/status` (`--porcelain=v2`) drives the tree colours;
  `POST /api/git/{stage,unstage,discard,commit}`. The new git write methods live
  on `src/execution/git.ts` under `withRepoLock`. **No** push, pull, merge, or
  branch operations.
- **Live via a filesystem watcher.** chokidar on the root, Excluded Directories
  skipped, events debounced, git status recomputed on `.git/index` + `HEAD`
  changes, and a coalesced `fs_changed` / `git_status` broadcast on the existing
  WS firehose bus.
- **Per-workspace exclude list** (JetBrains-style): seeded with `node_modules`,
  `.git`, and build dirs, shown greyed rather than hidden, toggled include /
  exclude per directory and user-extendable — a Setting Override on the Workspace
  (ADR-0022). The editor file-load cap (default 2 MB) and the watcher debounce
  are global config defaults.
- **Out of scope for v1:** search (filename and content), WYSIWYG Markdown
  editing (v1 is an edit ⇄ rendered-preview toggle), and push / pull / merge /
  branch.

## Consequences

- CodeMirror 6 enters the web bundle as the editor engine.
- The write surface widens Harmonic's blast radius from orchestration to
  arbitrary in-repo file mutation; the confined-root, operator-only,
  logged-writes boundary is the mitigation and must hold.
- `website/src/openapi.json` is regenerated for the new routes (ADR-0011); CI
  gates the drift.
- A live recursive watcher is a standing resource cost; the exclude set and the
  debounce bound it.

## Supersedes

None.
