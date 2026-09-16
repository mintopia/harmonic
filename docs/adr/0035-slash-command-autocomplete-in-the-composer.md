# Decision: Slash-command autocomplete in the Conversation Composer

Status: accepted
Date: 2026-09-16

Builds on ADR-0005 (ACP harness, Sessions), ADR-0006 (Conversations), and
ADR-0025 (`commandPrefix`, Harness Capability).

## Context

A Conversation drives a Harness over ACP (CONTEXT.md "Conversation"). The
Composer is a plain textarea + Send; it carries a **decorative** `/ commands`
footer hint that nothing backs — there is no slash-command registry, parser, or
forwarding anywhere in the codebase.

Slash commands are **not Harmonic's** — each Harness advertises its own set, and
the mechanism to learn them already flows through Harmonic:

- ACP emits `available_commands_update` as a `session/update` notification (name
  + description per command). The ACP driver forwards every session update
  generically via `onSessionUpdate` (`src/acp/driver.ts`); the conversation
  driver records them as generic session-update events and **extracts nothing**
  (`src/execution/conversation-driver.ts`). So the data arrives and is discarded.
- `commandPrefix` is already a **per-Harness** property (ADR-0025 §1; `/` for
  OpenCode). The trigger character is a Harness fact, not a UI constant.
- Harness Capability (ADR-0025 §3) is the established optional-Adapter pattern,
  but its two discoveries (`select_provider`, `select_model`) read **local
  metadata with no live session**. Slash commands are different: they are
  **session-sourced**, known only once the Harness's ACP Session is live.
- Harnesses spawn **lazily on the first Turn** today; nothing spawns ahead of a
  turn (`conversation-driver.ts`).

We want autocomplete: typing the prefix in the Composer opens a picker of the
Harness's advertised commands.

## Decision

### 1. Capture `available_commands_update`

The conversation driver gains a typed consumer for the `available_commands_update`
session update: it extracts each command (name, description, optional argument
hint) and stores the current list on the in-memory Conversation. No new
persistence — the list is ephemeral, scoped to the live Session, like the rest of
the session-update stream (ADR-0007).

### 2. Surface the list per-Conversation, survives reconnect

A WebSocket event pushes the current list to the frontend on each update, **and**
the conversation-detail GET includes the current list, so a refresh or reconnect
restores the picker without waiting for the next update. The frontend never
invents or hard-codes commands — the advertised set is the only source.

### 3. Eager-spawn the Session so commands exist from message one

The Composer spawns the Harness Session when it **opens**, not on the first Turn.
The ACP handshake (`initialize` → `session/new`) runs **no model inference and
costs no tokens** — only `session/prompt` is billed — so pre-warming to learn the
command set is token-free. An abandoned Session is reclaimed by the normal idle
timeout. Trade accepted: an opened Composer holds a warm subprocess + pipes +
Conversation Key until that timeout, even if no message is ever sent. This is
**new behaviour** — Harmonic has never spawned a Harness ahead of a Turn.

### 4. Trigger from the Harness's `commandPrefix`, at a whitespace boundary

The picker opens when the Harness's `commandPrefix` (`/` today) is typed at a
**whitespace boundary** — the start of the message or immediately after a space.
The query is the run of non-whitespace characters after the prefix; the picker
closes on a space, on no match, or on Escape. This is inline-capable (a prefix
mid-message after a space triggers it) yet a path like `src/foo` never does,
because the `/` there is preceded by a letter.

### 5. Insert, never send

Selecting a command replaces the trigger token (from the prefix to the caret)
with `{prefix}{name} ` — trailing space, caret after — so the operator can type
arguments. It **never auto-sends**: most commands take arguments, and an
argument-less auto-send would misfire. Keyboard while the menu is open: Arrows
move the highlight, **Enter and Tab select**, **Escape closes the menu without
sending**. Menu closed: Enter sends, as today. The forwarded turn text is the
raw string — Harmonic parses no commands and rewrites nothing.

### 6. Reuse the combobox pattern

The picker reuses `web/src/components/ModelCombobox.tsx`'s ARIA combobox,
keyboard navigation, outside-click dismissal, and scroll-into-view, adapted to
anchor **above** the Composer (it sits at the bottom of the panel). Rows show
**name + description**; matching is **case-insensitive prefix** on the command
name; a bare prefix shows the full list; visible rows are capped (~8) with
scroll. (ModelCombobox swallows Escape to keep a wrapping dialog open — the
Composer picker must **not** copy that; Escape closes the menu.)

## Alternatives considered

- **Static app-level command registry** — rejected: commands are per-Harness and
  Harmonic does not own them; a static list would lie the moment a Harness's real
  set differs (different skills installed, a different Harness selected).
- **Lazy — no menu until after the first Turn** — rejected: since the handshake
  is token-free, eager-spawn buys autocomplete from the very first message for
  only a bounded, idle-reaped resource cost. Worse UX for no token saving.

## Consequences

- The generic session-update passthrough gains its first typed consumer;
  advertised commands stop being discarded.
- The Conversation API/WS contract grows a field (the advertised command list) —
  a new contract surface consumed by the Composer.
- New runtime behaviour: a Harness Session is spawned on Composer open (token-
  free; resource cost bounded by the idle timeout).
- The decorative `/ commands` footer hint becomes real.
- No code ships with this ADR; it records the decided shape. Delivery is the epic
  and its child tickets.
