---
title: Feeding it work
description: How tickets reach the board, and the labels that decide which ones Harmonic runs on its own and which wait for you.
---

Harmonic runs the tickets you tell it to. This page covers how tickets
get onto the board and the one decision that controls what happens next:
whether a ticket is a human's to do or an agent's.

## Tickets come from your tracker

Once a Workspace's tracker is connected, Harmonic polls it and mirrors
every open issue onto the board, one card per issue, kept in sync on each
poll. The tracker stays the source of truth: edit an issue there and the
card follows. You don't maintain anything twice.

You can also add a one-off task by hand for work that isn't worth a
ticket; those get a review gate you control before anything merges (see
[Reviewing & merging](/harmonic/work/reviewing-and-merging/)). To work
with an agent interactively instead of queuing it, use a
[Conversation](/harmonic/work/conversations/).

## The label decides who does it

Every mirrored ticket is either **for an agent** (Harmonic runs it
unattended) or **for a human** (it waits for you). Harmonic reads that
from the ticket's labels:

| A ticket labelled… | …is | and Harmonic |
| --- | --- | --- |
| `ready-for-agent`, `research` | for an agent | starts running it as soon as there's a slot |
| `ready-for-human`, `grilling`, `prototype`, or a plain decision | for a human | shows it on the board but never runs it |

When the labels are ambiguous, Harmonic leans toward running it rather
than letting it sit, then hands it back if it turns out to need you.

The labels aren't Harmonic's invention, they're the ones the
[Matt Pocock's Skills](/harmonic/start/spec-driven-development/) already
apply as they turn a spec into tickets. A ticket those Skills marked
ready for an agent runs with no extra step from you.

## Flip it yourself

You don't have to go through the tracker to change a ticket's mind. On the
board you can hand a waiting ticket to an agent, or pull one back to work
on yourself, and Harmonic respects the change on the next poll without
fighting the tracker over it.

## Controlling how much runs at once

Tickets that are ready for an agent don't all start at once. The
**Auto-Runner** starts them in order, and you have three dials:

- **Priority** (high / normal / low) sets which ready ticket goes next;
  ties break oldest-first.
- **Concurrency** caps how many agents a Workspace runs at the same time,
  under a machine-wide ceiling so one Workspace can't swamp the host.
- **The master switch** pauses or resumes all automatic running at once,
  across every Workspace, when you want hands on the wheel.

## When a ticket can't finish on its own

Two things take a running ticket off the automatic path:

- **It needs a decision.** If the agent hits a permission prompt or a
  question it can't answer, Harmonic stops, flags the ticket "escalated to
  human," and leaves it for you. It won't auto-run again until you take
  over.
- **The work didn't hold up.** If the agent's own review rejects the
  change, or it finishes without actually resolving the ticket, Harmonic
  tries a fresh run up to a set limit, then escalates rather than retrying
  forever.

Either way the ticket comes back to you clearly marked, never silently
dropped. See
[Watching & steering the fleet](/harmonic/work/steering-the-fleet/) for
picking those up, and
[Reviewing & merging](/harmonic/work/reviewing-and-merging/) for what
happens to the code when a ticket does pass.
