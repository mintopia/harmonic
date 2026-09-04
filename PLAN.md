# Plan: Activity page — agent-focused Fleet Lanes redesign
_Locked via grill-with-docs — Claude + Jess. Terms per CONTEXT.md._

## Goal
Rebuild the Activity page as a **strictly read-only, whole-fleet glance** of every
in-flight Agent (root Process Tree node) and its Subagents, foregrounding each
node's **context fill**, tokens, cost, model, subagent hierarchy, and **last
tool**. The streaming Subagent transcript is removed from Activity — it lives on
the Task page. Layout is **Fleet Lanes**: each Agent is a horizontal lane whose
hero element is a wide live context meter; Subagents are indented sub-lanes.

## Approach
1. **Server** — add per-node `lastTool: string | null` (most-recent tool name) to
   `ProcessNode`, computed in the usage-sampler where the tree is built (reuse
   `toolCallName` + event walk + `parentToolUseId` subagent attribution). Degrade
   to `null` when a harness/adapter can't supply it.
2. **DTO / types** — thread `lastTool` through `src/server/dto.ts` and
   `web/src/types.ts` (`ProcessNode`). Leave the prose `activity` field in place
   (used elsewhere); the Activity view simply stops rendering it.
3. **Web model** (`web/src/activity-model.ts`) — default sort = **context fill
   desc**; keep Type (All / Attempts / Conversations) + Workspace filters; summary
   strip = **Agents · Subagents · Cost · Fleet tok/s · Machine ceiling** (drop
   "Needs you").
4. **Rebuild `ActivityView.tsx` as Fleet Lanes:**
   - Root Agent lane: state dot · name + ref/`Chat` tag · model line · **wide
     context meter** (teal when cool → amber → rose as the window fills, `k/k · %`
     inside) · tokens · cost · **last tool** (teal).
   - Subagent = indented sub-lane; **indent is the only signal** (no badge), same
     name/model treatment as the Agent. One level deep.
   - **No actions**: no Stop, no Grant/Deny, no Resolve, no transcript. The whole
     lane deep-links to the Agent's Task / Conversation page.
5. **Delete Activity-only dead paths** — the transcript/`EventStream` pane and
   `ProcessDrillIn` usage in Activity, permission-answer + escalation-resolve
   wiring, expand/collapse tree state, and any `activity-actions-model` bits used
   only here. Keep `EventStream` / `ProcessTree` if the Task page still uses them.
6. **Tests** — update `tests/activity-model.test.ts` (new sort default + summary),
   add `lastTool` to fixtures. Visual-parity pass against the mockup, then run the
   full suite **once** at the end.

## Key decisions & tradeoffs (grill)
- **Agent / Subagent** are the display terms (industry-standard, not abstracted).
  Glossary updated: added the **Agent** term; **Activity** is now *strictly
  read-only*.
- **Fleet Lanes** chosen over tables / cards / process-tree. Context fill is the
  primary live signal, so the **meter is the row**.
- **Single** last tool — no trail, no prose "activity" line.
- **Strictly read-only** — no Stop / permission / resolve on Activity; deep-link
  only. (CONTEXT.md Activity entry updated to match.)

## Related scope (NOT this work)
- **Global "permission required" alert** at the top of every page (app shell) —
  the reason Activity no longer answers permissions. Needs its own spec/ticket.

## Out of scope
- The Task-page transcript (unchanged). Deeper (>1 level) subagent-nesting
  visualization (a future per-agent Tree drill-in). Collapsible subagents.

## Risks / open
- Per-node `lastTool` for Codex / Copilot adapters (Claude confirmed via session
  log). Verify each adapter can supply it; the view must render cleanly on `null`.
