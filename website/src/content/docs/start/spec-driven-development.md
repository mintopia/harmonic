---
title: Spec-driven development
description: How Harmonic turns a spec into a backlog of tickets and runs the ready ones out to merged code, so you spend your time on decisions instead of typing.
---

Harmonic is built for a particular way of working: you decide *what* to
build and write it down, then let coding agents do the *building*. The
writing-down is the spec. The building is a queue of tickets. Harmonic is
what drains the queue.

## The idea

Handing an agent a vague "add billing" rarely ends well. Spec-driven
development breaks the work down first:

1. **Write a spec.** What you're building, and why. The durable artifact
   that outlives any single agent run.
2. **Break it into tickets.** Small, well-scoped issues in your tracker,
   each one a self-contained piece of the spec with enough context for an
   agent to finish it alone.
3. **Let the tickets run.** The ones that are ready for an agent get
   implemented, reviewed, and merged, one after another, without you in
   the loop for each one.

You stay where your judgement matters, on the spec and the decisions, and
the mechanical work of implementing each ticket runs itself. A backlog
stops being a list you chip away at and becomes a queue that empties on
its own.

<figure aria-label="You write a spec; Matt Pocock's Skills turn it into tickets; Harmonic implements, reviews, and merges each ready ticket unattended, escalating back to you when one needs a human.">
<svg viewBox="0 0 1000 214" role="img" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">
<defs>
<marker id="sd-arw" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--sl-color-accent)" /></marker>
<marker id="sd-arw-muted" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--paper-await)" /></marker>
</defs>
<text x="95" y="58" text-anchor="middle" font-size="13" font-weight="600" fill="var(--sl-color-text-accent)">You</text>
<text x="291" y="58" text-anchor="middle" font-size="13" font-weight="600" fill="var(--sl-color-text-accent)">Matt Pocock's Skills</text>
<text x="683" y="44" text-anchor="middle" font-size="13" font-weight="600" fill="var(--sl-color-text-accent)">Harmonic — unattended</text>
<path d="M412 66 L412 60 L954 60 L954 66" fill="none" stroke="var(--sl-color-accent)" stroke-width="1.5" />
<rect x="20" y="82" width="150" height="60" rx="10" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5" />
<text x="95" y="109" text-anchor="middle" font-size="15" font-weight="600" fill="var(--sl-color-white)">Spec</text>
<text x="95" y="128" text-anchor="middle" font-size="11" fill="var(--sl-color-gray-3)">what you want built</text>
<rect x="216" y="82" width="150" height="60" rx="10" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5" />
<text x="291" y="109" text-anchor="middle" font-size="15" font-weight="600" fill="var(--sl-color-white)">Tickets</text>
<text x="291" y="128" text-anchor="middle" font-size="11" fill="var(--sl-color-gray-3)">issues in your tracker</text>
<rect x="412" y="82" width="150" height="60" rx="10" fill="var(--sl-color-accent-low)" stroke="var(--sl-color-accent)" stroke-width="1.5" />
<text x="487" y="109" text-anchor="middle" font-size="15" font-weight="600" fill="var(--sl-color-white)">Implement</text>
<text x="487" y="128" text-anchor="middle" font-size="11" fill="var(--sl-color-gray-3)">a coding agent</text>
<rect x="608" y="82" width="150" height="60" rx="10" fill="var(--sl-color-accent-low)" stroke="var(--sl-color-accent)" stroke-width="1.5" />
<text x="683" y="109" text-anchor="middle" font-size="15" font-weight="600" fill="var(--sl-color-white)">Review</text>
<text x="683" y="128" text-anchor="middle" font-size="11" fill="var(--sl-color-gray-3)">it checks its own work</text>
<rect x="804" y="82" width="150" height="60" rx="10" fill="var(--sl-color-gray-6)" stroke="var(--paper-done)" stroke-width="1.5" />
<text x="879" y="109" text-anchor="middle" font-size="15" font-weight="600" fill="var(--sl-color-white)">Merge</text>
<text x="879" y="128" text-anchor="middle" font-size="11" fill="var(--sl-color-gray-3)">merged &amp; closed</text>
<line x1="174" y1="112" x2="212" y2="112" stroke="var(--sl-color-accent)" stroke-width="2" marker-end="url(#sd-arw)" />
<line x1="370" y1="112" x2="408" y2="112" stroke="var(--sl-color-accent)" stroke-width="2" marker-end="url(#sd-arw)" />
<line x1="566" y1="112" x2="604" y2="112" stroke="var(--sl-color-accent)" stroke-width="2" marker-end="url(#sd-arw)" />
<line x1="762" y1="112" x2="800" y2="112" stroke="var(--sl-color-accent)" stroke-width="2" marker-end="url(#sd-arw)" />
<path d="M683 142 L683 176 L95 176 L95 148" fill="none" stroke="var(--paper-await)" stroke-width="1.5" stroke-dasharray="4 4" marker-end="url(#sd-arw-muted)" />
<text x="389" y="196" text-anchor="middle" font-size="11" fill="var(--paper-await)">needs a human? Harmonic escalates the ticket back to you</text>
</svg>
</figure>

## Where Harmonic fits

Harmonic is designed to work alongside **Matt Pocock's Skills**, a set of
Claude Code skills for spec-driven development. The Skills are what turn a
spec into tickets: `/research` and `/wayfinder` to chart the work and make
the decisions, `/to-tickets` to turn a plan into issues, `/implement` to
build one. They author the tickets in your tracker and label them as they
go.

You wire the two together once, in your repo, with the Skills' own
`/setup-matt-pocock-skills` command: it installs the Skills and sets up the
issue tracker that Harmonic then reads. From there the Skills write tickets
and Harmonic runs them.

Harmonic is the layer that **runs** those tickets. It watches your
tracker, and when a ticket is labelled ready for an agent it starts one,
hands it the right command for that kind of ticket, and takes the result
all the way to a merged branch. The Skills stay the source of truth for
*what* each ticket is; Harmonic owns *running* it.

So the division of labour is:

| You | Matt Pocock's Skills | Harmonic |
| --- | --- | --- |
| Decide what to build; approve the plan | Turn the spec into labelled tickets | Run the ready tickets to merged code |
| Answer the questions agents can't | Define what "done" means per ticket | Retry, escalate, and merge |

## What "runs it" means

For each ticket that's ready for an agent, Harmonic:

- starts a coding agent (Claude Code, Codex, Copilot, or OpenCode) on it,
- gives it the ticket and the command that ticket calls for, like
  `/implement`,
- lets the agent do the work and review it, then
- merges the branch and marks the ticket done, or hands it back to you if
  it got stuck.

Nothing here is bespoke to one ticket. The same line runs every ready
ticket the same way, which is what lets a whole spec's worth of work go
through unattended while you watch a board.

## Not every ticket runs itself

Some tickets are decisions, not builds, research, a prototype, a design
call. Those are marked for a human and stay on the board for you to work
through with the Skills directly; Harmonic surfaces them but won't run
them. Only the build tickets you've marked ready for an agent run
automatically. See [Feeding it work](/harmonic/work/feeding-it-work/) for
exactly what gets picked up.

## Where to go next

- **[Feeding it work](/harmonic/work/feeding-it-work/)** — the labels
  that decide what runs and what waits for you.
- **[Watching & steering the fleet](/harmonic/work/steering-the-fleet/)** —
  the board, live activity, and taking over a stuck ticket.
- **[Reviewing & merging](/harmonic/work/reviewing-and-merging/)** — the
  checks between an agent's work and your main branch.
