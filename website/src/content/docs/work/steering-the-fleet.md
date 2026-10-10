---
title: Watching & steering the fleet
description: The board and the live activity view, and how to step in when a ticket needs you.
---

Most of the time Harmonic runs without you. This page is about the times
you look in, and the times it asks you to.

## The board

Each Workspace has a board, one card per ticket, that mirrors your
tracker. At a glance you can see what's waiting, what's running right now,
what finished, and what got handed back to you. It's built to sit on a
side monitor: you watch the queue drain and only lean in when a card asks
for it.

## Watching a ticket work

Open any running ticket to watch its agent live. As it works you see what
it's reading, the changes it's making, its plan, and its reasoning, streamed
as it happens, with running token usage and cost. You don't have to watch,
but when you want to know *why* an agent did something, it's all there
rather than buried in a log after the fact.

There's also an instance-wide activity view that shows every agent running
across all your Workspaces at once, with the same live usage and cost, so
you can see the whole fleet's load in one place.

## The timeline

The board shows where every ticket stands right now; the **timeline** shows
what the fleet has been doing. It lays every attempt each harness has run
onto one clock, so you can see what overlapped, what took a while, and when
it happened. Scrub the playhead back to any moment to read the fleet's state
then, or open an attempt to step through its own run. Choose a 24-hour or
7-day window. Each unattended Attempt also records its effective permission
mode here. If a requested mode was unavailable, the timeline shows the
requested-to-effective fallback rather than hiding the change.

## When a ticket needs you

A ticket comes back to you in one of two ways, and both are marked clearly
on the board rather than failing silently:

- **Escalated.** The agent hit something only a human can settle, a
  permission it needs granted, or a question it can't answer, so Harmonic
  stopped it and flagged the ticket for you. It won't run automatically
  again until you take it on.
- **Out of retries.** The work didn't hold up and Harmonic exhausted its
  automatic retries. The ticket is left open and flagged for you to look
  at.

## Retry, Accept and Close

An escalated ticket has three actions on its page. They sit in a bar across
the main column, directly under the Escalated banner. Hover over Accept to
see a short explanation of what it will do at the current step.

- **Accept** overrides the step that failed and carries on with the pipeline.
  Its label names that step: **Accept & implement** after a failed rebase,
  **Accept & verify** after a failed implementation, **Accept & review** after
  a failed verification, and **Accept & merge** after a failed review. If no
  step is known, it reads **Accept**. Accepting at the final review merges the
  candidate as it is. Accept is disabled, with *No candidate commits to accept*,
  when there is nothing to accept.
- **Retry** sends the ticket back to the queue on the same branch, and the
  attempt budget starts over. The dialog has these fields:
  - **Guidance (optional)**: what was wrong and what the next Attempt should do
    differently. It is recorded on the escalated Attempt and given to the next one.
  - **Harness and Model**: the route the next Attempt uses. Choosing a different
    one saves it on the ticket, which replaces the ticket's Routing Label. The
    dialog says when a label will no longer apply.
  - **When**: **Retry** queues the next Attempt, and it starts when a slot is free.
    It continues the current Session only if that Session is still warm and the
    Harness and Model are unchanged. **Retry Now** starts the next Attempt at once,
    without waiting for a free slot. When there is a prior Session to re-use,
    **Re-use the same Session** appears; it is unavailable when the Harness
    changes, because a different Harness needs a new Session. The dialog warns
    when the Session is cold, or when the Model is switched within it, because
    the cached context can't be reused then and the run costs more.

  The confirm button is labelled to match: **Retry**, **Retry Now**, or
  **Retry Now in this Session** when the Session is re-used.
- **Close** ends the ticket without merging its candidate. It removes the branch
  and worktree and closes the tracker issue. It asks you to confirm first, and it
  cannot be undone.

An escalated Epic has its own panel. See [Epics](/harmonic/work/epics/).

## Taking over

When you pick up a flagged ticket, you're working it by hand, with the same
agents, through [Matt Pocock's Skills](/harmonic/start/spec-driven-development/)
directly, or however you'd normally resolve it. Answer what the agent
couldn't, and either finish it yourself or hand it back for another
automatic run once it's unblocked.

## Steering, pausing, and resuming a ticket

You don't have to wait for a ticket to come back to you. Type into the steer
box on a running ticket and your message goes straight to the agent's
current conversation, or waits for the end of its current turn if it can't
be interrupted.

**Pause** asks the agent to finish what it's doing and stop, keeping its
work and its conversation. **Resume** picks the same attempt back up.
Steering a paused ticket resumes it and delivers your message in one step.

A pause can last as long as you like. If the saved conversation can't be
reloaded as it was, for example after you upgrade Harmonic, the agent starts
again from a summary of the work so far. Resuming a ticket that's been left
a while costs more, because the provider's cache has gone cold, but it's
never refused. The same goes for a ticket whose agent process has gone:
steer or resume it and it picks up again.

If a running ticket is close to its time limit, **Extend** gives it more
time without restarting it. The ticket shows how much time it has left.

## Pausing everything

The **Pause** button in the header freezes every running ticket in every
Workspace, and anything that starts while it's on is paused straight away.
Press **Resume** and paused tickets carry on. The **Auto-runner** switch
next to it is separate: turning it off stops Harmonic picking up new work,
but leaves running tickets alone. Per-Workspace
throughput dials (priority and concurrency) live in
[Settings & overrides](/harmonic/run/settings/).
