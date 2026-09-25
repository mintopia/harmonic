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
