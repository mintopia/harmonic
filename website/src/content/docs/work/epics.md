---
title: Epics
description: Running a group of tickets as one unit, how Members are scheduled, what you watch, and what happens when one gets stuck.
---

Some tickets are too big for one agent run. An Epic groups the tickets
underneath a tracker issue and runs them as one unit, in parallel where it
can, merged together, and reported on as a whole.

## Set up an Epic

You don't create Epics in Harmonic. You set the ticket structure up in
your tracker, and Harmonic reads it on the next poll:

- Give a parent issue child tickets: native sub-issues, or a body
  task-list / `Part of #<n>` line, whatever your tracker supports.
- The **leaf-most** parent (the one whose children aren't themselves
  parents) is the Epic that actually runs. A deeper hierarchy above it is
  fine; only the bottom level schedules and merges work.
- Order the children with `Blocked by` links between them, same as any
  other ticket. A child with an open blocker sits out until it clears.
  The Epic issue groups its children, it never blocks them.

Harmonic marks one kind of Epic on the board, a **Map** (wayfinding
children). Any other parent/child grouping shows and behaves the same
way, badged plainly as an Epic.

Each child still needs `ready-for-agent` to run unattended, same as any
ticket, see [Feeding it work](/harmonic/work/feeding-it-work/).

## Watch it run

Epics get their own band on the board, above the plain ticket cards.
Collapsed, it shows the Epic's title, a pip per Member colored by status
(waiting, ready, running, merged, blocked, escalated, cancelled), and a
count if any Member needs attention. Expand it and you get columns of
what's waiting on what, with each ticket's remaining blockers listed
underneath it, struck through once they clear. Members that are done
drop into a closed rail below, out of the way but still there if you want
to check one.

Once every Member has merged, the band grows an integration bar with four
steps: Verify, Merge, Post-merge check, Retire, so you can see at a
glance whether the Epic is still merging or waiting on something.

## The Epic page

Click an Epic's title to open its own page: description, integration
progress, a timeline of what's happened, usage and cost across every
Member, the Epic's verification stages if you've configured any, and a
table of every child ticket with its own status and cost. From there you
can also open the whole-Epic diff, everything `epic/<ref>` changes over
your base branch, file by file, the same changed-files view you'd get on
a single ticket.

## Worktree vs. direct Members

How an Epic's Members run changes what "merge" means for the whole
group:

- **Worktree Members** share an `epic/<ref>` integration branch. Each
  Member's own worktree forks off it and merges back onto it as it
  finishes. Once every Member has merged there, the Epic runs its own
  verification against that branch before merging it into your base and
  deleting it.
- **All-direct Epics** never cut a branch. Members commit straight onto
  your base branch as they finish, and once the last one's done the Epic
  is just marked complete, with no separate merge and no Epic
  verification step.

See [Branches & worktrees](/harmonic/work/branches-and-worktrees/#epics)
for the git-level diagram of both paths.

## Configure Epic verification

Beyond what each Member checks on its own, you can add a check that runs
against the whole Epic before it merges: any number of commands, plus
named critics, run against the integration branch as it stands once every
Member is in. Switch **Settings → Verification** to the Epic scope to set
it up. It's off until you add at least one command or critic there, same
as task-level verification.

## When a Member gets stuck

A Member that escalates behaves like any other ticket: it stops, gets
flagged, and waits for you, see
[Watching & steering the fleet](/harmonic/work/steering-the-fleet/#when-a-ticket-needs-you)
for picking it up. Until it's cleared, it holds the Epic's merge back.
You'll see it called out in the board's attention count and sitting in
the blocked column when you expand the band.

If the Epic's own verification is stuck, failed and out of automatic
attempts, the Epic page shows an escalation panel of its own: a text box
for guidance and two ways forward, **Continue with guidance** (keeps
working from where it left off) or **Reject and start fresh** (requeues
with a clean run). Either way, add what the resolver got wrong and it
picks the work back up.
