---
title: Quickstart
description: Install Harmonic, point it at your tracker, and watch it take one labelled ticket from open to merged with no further input.
---

By the end of this page one ticket in your tracker will have been
implemented, reviewed, and merged, and you won't have touched an editor.
That's the whole idea: you describe work as tickets, and Harmonic works
through them.

## 1. Install and start it

```sh
npm install -g @mintopia/harmonic
harmonic start          # runs in the background; logs to ~/.harmonic/harmonic.log
```

No global install? Every command works through `npx @mintopia/harmonic …`
instead. Check on the background server any time with `harmonic status`,
and stop it with `harmonic stop`.

Then open **`http://localhost:4700`**.

:::caution
With no password set, Harmonic is reachable by anyone on your network.
Before you expose it, set a password or bind it to `127.0.0.1`. See
[Security](/harmonic/run/security/).
:::

## 2. Point it at a repo

Harmonic works on one repo at a time through a **Workspace**, a named
folder pointing at a repo root. There's always one to start with; set its
folder to the repo you want worked on.

## 3. Connect your tracker

Harmonic pulls work from your issue tracker, which you set up with
[Matt Pocock's Skills](/harmonic/start/spec-driven-development/). Run his
`/setup-matt-pocock-skills` command in your repo once: it installs the
Skills and configures the tracker (GitHub, GitLab, or local Markdown) that
Harmonic reads. Then turn on the Workspace's tracker in Harmonic and let it
poll.

Every open issue shows up on the board within a poll or two. You're not
managing a second copy of anything, the tracker stays the source of
truth and Harmonic mirrors it.

## 4. Label a ticket for an agent

By default the tickets on the board just sit there for you to read.
Label the one you want done `ready-for-agent`, and Harmonic takes it from
here: it queues the ticket and starts a coding agent on it as soon as
there's a free slot.

## 5. Watch it merge

Open the ticket and watch the agent work in real time: what it's reading,
what it's changing, what it's thinking. It implements the change, reviews
its own work, and closes the ticket. When it does, Harmonic merges the
branch for you. Done, no editor, no copy-paste.

If the agent hits a question it can't answer, it stops and hands the
ticket back to you rather than guessing. That's the only time you need to
step in.

## Where to go next

- **[Spec-driven development](/harmonic/start/spec-driven-development/)** —
  the bigger picture: turning a spec into a backlog of tickets Harmonic
  runs out to merged code.
- **[Feeding it work](/harmonic/work/feeding-it-work/)** — which tickets
  get picked up, and how to control that with labels.
- **[Reviewing & merging](/harmonic/work/reviewing-and-merging/)** — the
  checks between an agent's work and your main branch.
