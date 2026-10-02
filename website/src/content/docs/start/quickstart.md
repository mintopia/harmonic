---
title: Quickstart
description: Install Harmonic, configure its agent and verification, and start one labelled ticket from your tracker.
---

By the end of this page Harmonic will be working on one ticket from your
tracker. You describe work as tickets, configure how it is checked, and
Harmonic works through them.

## 1. Install and start it

Needs Node.js 22+ and git — 2.38+ recommended so merges can reconcile a moved
base branch without rebuilding; an older git still works, it just rebuilds on
every base advance instead.

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

Each **Workspace** is a named folder pointing at a repo root. There's
always one to start with; set its folder to the repo you want worked on.
You can add more Workspaces to run work across several repos.

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

## 4. Configure execution and enable the Auto-Runner

Sign in to the Harness you want to use on the machine running Harmonic,
then select it in the Workspace's defaults. Claude is the shipped default;
see [Harnesses](/harmonic/run/harnesses/) for login instructions.

Choose an Isolation Mode in the Workspace's defaults. **Direct** is the
shipped default and changes the Working Directory in place. Choose
**Worktree** to work on a separate branch that Harmonic merges when the
Task passes verification.

Configure verification commands and Critics for the repository before
running work. Both lists are empty by default, so installing Harmonic
does not provide automated testing or agent review by itself. See
[Reviewing & merging](/harmonic/work/reviewing-and-merging/).

Turn on the Workspace's **Auto-Runner**, which is disabled by default,
and make sure the global master switch is on. Then label the ticket you
want done `ready-for-agent`. Harmonic starts it when a slot is free.

## 5. Watch it finish

Open the ticket and watch the agent work in real time: what it's reading,
what it's changing, what it's thinking. It implements the change and runs
your configured verification. Successful work completes in place in Direct
mode, or is merged automatically in Worktree mode, and the tracker ticket
is closed.

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
