---
title: Browsing & editing files
description: The in-app file browser, editor, and basic git for a Workspace.
---

Sometimes you want to look at what an agent changed, or fix something by
hand, without leaving Harmonic for a terminal. The **Files** view is a small
web IDE scoped to one Workspace, rooted at its Working Directory.

## The file tree

Open **Files** from the Workspace rail. The tree lists the repo from its
root, and colours each entry by git status — modified, added, untracked — so
you can see what has changed at a glance. Heavy directories like
`node_modules`, `.git`, and build output are seeded into a per-Workspace
exclude list and shown greyed rather than hidden; toggle any directory in or
out yourself.

One repo root per view — the active Workspace's Working Directory. Per-task
worktrees aren't folded in here; those stay in the Operations and diff
surfaces.

## Editing and saving

Click a file to open it in a tabbed editor. Text files edit in place and
save with `⌘S`; Markdown toggles between the source and a rendered preview.
Images and audio preview inline, and files past the edit cap (2 MB by
default) offer a download instead. Nothing is written until you save.

## Git, the basic parts

The source-control panel stages, unstages, discards, and commits changes,
with the same status colours as the tree. That's deliberately all of it —
no push, pull, merge, or branch. Those stay in your terminal; the Files view
is for reading and hand-fixing a working tree, not for driving shared
history.

## Live as it changes

A filesystem watcher keeps the tree and git status current as files change
on disk, whether you're editing them or an agent is, so the tree always
reflects what's on disk right now.

## What it can reach

Every read and write is confined to the Workspace's Working Directory:
`..` traversal and symlink escape are rejected, the view is operator-only,
and every write is logged. It cannot touch files outside the workspace root.
