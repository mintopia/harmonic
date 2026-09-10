# Decision: Conversations as a first-class view with rich transcript rendering

Status: accepted
Date: 2026-09-10
Implementation pending (epic to follow). Extends ADR-0006 (Conversations) and
ADR-0011 (Web UI conventions); changes no lifecycle, table, or API contract.
Shipped in phases — v1 (rendering + shell) is the committed scope here; v2
(composer) and v3 (work-session) are recorded as intent, not built.

## The Conversation surface is promoted to a first-class view

A Conversation today is reachable only as a docked overlay (`route.conversation`).
It becomes a **top-level, workspace-scoped view** — its own entry in the nav
rail, its own `view=conversations` route, deep-linkable to a specific
Conversation. This is a **client route**, not an API `view`/`mode` flag: the
`conversations` list endpoint stays lean and paginated exactly as ADR-0011
requires, and the conversation id rides the existing URL params (ADR-0009 makes
Conversations workspace-scoped, so the route is too).

The **dock survives as a quick-peek** — messaging a harness without leaving the
current view is a flow worth keeping. The full-page view and the dock render the
**same transcript and composer components**; only the surrounding chrome differs.
This is deliberate: one renderer, two mounts, no forked UI to keep in sync.

The full-page layout is **two-pane plus a collapsible context drawer**: a
Conversation rail on the left, the transcript and composer as the main column,
and a drawer (collapsed by default) for the telemetry, model, working directory,
and Permission Rules that already exist but should not eat transcript width.

## Transcript rendering is tool-kind aware

The transcript stops rendering every tool call as an identical grey collapsible.
**Three tool kinds get bespoke cards** — the ones that carry the visual payoff:

- **edit → a diff** (syntax-highlighted, add/remove gutters).
- **execute → a terminal card** (command line plus streamed output).
- **read → a file card** (path plus line range).

Every other kind (delete, move, search, fetch, think, other) gets a **consistent
icon-plus-one-line summary**, still expandable to the raw input/output. Nothing
renders as a bare grey box; nine bespoke designs are not built for a v1.

## Diffs require capturing an event field the model currently drops

`ToolCallView` (`web/src/event-stream-model.ts`) carries only
`toolKind/title/status/input/output`; `toolContentOutput` keeps **only `.text`**
off each ACP content block, so the ACP structured **diff block**
(`path`/`oldText`/`newText`) is silently discarded. Rendering a real diff means
**extending the model to retain that block**, degrading to today's raw
input/output view when a harness does not emit it.

That model layer is **shared by shape** with the Attempt and Verification
transcripts (`ChatTranscript.tsx`, per ADR-0006's "shared by shape, not table").
Capturing the diff block therefore upgrades those surfaces for free — and makes
them a surface this change must not regress. Which harnesses emit the block, and
in what shape, is confirmed by a build-time spike, not assumed.

## Syntax highlighting: highlight.js via marked-highlight

The web bundle renders Markdown with `marked` + `dompurify` and nothing else —
no highlighter. Code blocks (and diff-card bodies) get one by adding
**highlight.js** through **`marked-highlight`**, hooking the existing `marked`
pipeline.

The alternative was **Shiki** — VS Code-grade fidelity and dual light/dark
themes that would pair cleanly with Paper's theme tokens. It is rejected for v1
on **bundle weight and async/WASM complexity** against a lean dependency posture
(the app's non-infrastructure runtime footprint is small). highlight.js is
synchronous, broadly covers languages, and integrates in one hook. Revisiting
Shiki later is a fresh decision, not a regret this one forecloses.

## Vocabulary is enforced at the surface

The glossary already bans **agent / chat / session / thread** as ambiguous. The
UI still says "Message the agent…". The redesign removes those nouns from
operator-facing copy and **labels the responder by its product name** (Claude,
Codex, OpenCode) rather than the internal term "harness", which is jargon to an
operator. Verbs stay natural ("Message…"). No glossary edit is needed — this is
enforcement, not a new term.

## Two transcript behaviors the current view lacks

- **Smart auto-scroll**: the transcript pins to the bottom only while the reader
  is already there; scrolling up to read history is not yanked back, and a "jump
  to latest" affordance returns them. Today it force-scrolls on every event.
- **A live "now running" indicator**: what the harness is doing *right now* is
  legible without reading the tail of a wall of collapsibles.

## Phasing

- **v1 — rendering + shell** (this decision): the view, the shared rich renderer,
  the three bespoke cards, diff-block capture, highlight.js, smart scroll, the
  live indicator, and the vocabulary pass.
- **v2 — composer**: auto-grow, per-Conversation drafts, slash-commands,
  @-file mentions, image paste/attach. Attachments are **not plumbed** — the
  whole chain (composer → HTTP body → `conversation_events` → ACP `session/prompt`)
  carries one bare string today; multi-block prompts are backend + wire work,
  scoped separately.
- **v3 — work session**: in-conversation search, jump-to-turn, keyboard
  shortcuts, multi-Conversation ergonomics.

## Consequences

- A new top-level view joins the rail (`rail-model.ts`, `App.tsx`, `NavRail.tsx`);
  the dock overlay and the view share transcript/composer components, so those
  components move to a shared location and both mounts consume them.
- `event-stream-model` gains a diff field; `ChatTranscript` (Attempts,
  Verification) rides the model change and must be regression-tested alongside
  the Conversation view.
- Two net-new runtime dependencies enter the web bundle (`highlight.js`,
  `marked-highlight`); the Paper contrast test remains a hard CI gate, so every
  highlight and diff token pairing must clear AA in both themes.
- The look is agreed in a design canvas before data is wired (shell + tool-card
  gallery), then built to parity.
- v2's attachment support is gated on a separate backend change to carry
  multi-block prompt content end to end.

## Supersedes

None. Extends ADR-0006 (Conversations) and ADR-0011 (Web UI and API
conventions); contradicts neither.
