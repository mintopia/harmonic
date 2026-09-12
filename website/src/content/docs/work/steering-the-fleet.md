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
7-day window.

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

## Pausing everything

When you want hands on the wheel across the board, the master switch in the
header pauses all automatic running at once, every Workspace, immediately.
Flip it back on and the queue picks up where it left off. Per-Workspace
throughput dials (priority and concurrency) live in
[Settings & overrides](/harmonic/run/settings/).
