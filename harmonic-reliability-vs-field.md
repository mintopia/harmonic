# Harmonic vs. the field: AFK agent reliability

*Compiled 2026-08-16. Compares how Harmonic executes/controls unattended coding agents against 13 comparable systems, and extracts concrete techniques to raise task-execution reliability. Competitor claims are from primary sources (docs, engineering blogs, source, papers); Harmonic claims are from its own source + ADRs.*

---

## TL;DR — where Harmonic stands

**Harmonic is already ahead of most named competitors on the *workflow* axis** — the thing that decides whether unattended work is trustworthy:

- **Honest completion signal.** "Clean harness exit ≠ success" (ADR 0011). Success = agent called `finish_task` / closed the tracker ticket; a clean run that left the ticket open is *unresolved* → retry/escalate, branch **not** merged. This directly attacks the #1 failure mode of the whole field — *"agent claims done but isn't."* Only Sculptor and Factory attack it as squarely.
- **Explicit escalate-to-human** (`escalate_task`, permission-request-in-afk, retry-exhausted, merge-conflict) — never silently strands work.
- **Dependency graph with `blocked`-until-met** — ahead of nearly every competitor (most boards are human-ordered only).
- **Safe crash recovery** — orphaned `running` runs at boot are *failed*, never silently re-run (avoids double-execution/stomping). Safer default than most.
- **Harness-agnostic over ACP** — no vendor lock-in; unique among these.
- **Mandatory human review gate** + worktree-per-run → branch → merge-on-accept.

**Where Harmonic is thin — and the field has proven fixes.** All six gaps below are *runtime backstops*, the part a board leaves to the harness. For an unattended fleet, that's exactly the part the operator can't watch.

---

## The 6 reliability gaps (confirmed in Harmonic source)

| # | Gap | What exists today | Who solves it well |
|---|-----|-------------------|--------------------|
| G1 | **No run wall-clock / idle timeout, no liveness heartbeat** — a hung-but-alive agent that never ends its ACP turn runs forever; only process death or an operator `cancel` stops it | `conversationIdleTimeoutMinutes` (conversations only) | Copilot (59-min hard cap), SWE-agent (cost budget), Cursor (required spend limit) |
| G2 | **No per-run token/$ budget kill-switch** — Usage is measured live but never *enforced* | live usage tailer (observability only) | SWE-agent ($4/instance → auto-submit), Cursor (spend limit) |
| G3 | **Stuck/loop protection is turn-count only** — `continueAttempts` only bites when the agent *ends* a turn; within-turn spinning is invisible | `continueAttempts`, `autoRetry` | **OpenHands StuckDetector** (20-event window, 5 patterns, de-duped nudge) |
| G4 | **No automated pre-review verification** — completion is human review (native) or ticket-closed (mirrored); no "did it really do it" evidence, no enforced test/lint gate | `isResolved` (ticket state only) | **Sculptor** ("tests passed w/o real tests" detection), **Factory Droid Control** (CONFIRMED/REFUTED/INCONCLUSIVE + evidence) |
| G5 | **No self-healing feedback loop** — a settle-time lint/test failure isn't piped back to the agent as a fix prompt | none | **Aider** (reflection loop, cap 3), **SWE-agent** (revert-edit-on-lint, +3 pts measured) |
| G6 | **Crash recovery fails-forward, never resumes** — a restart mid-run costs the whole run (worktree branch survives, ACP session/context does not) | `markInterrupted` → failed → requeue | OpenHands (event-sourced replay), Devin (machine snapshots), Codex (12h container cache) |

---

## Ranked recommendations (highest leverage first)

### 1. Per-run budget kill-switch — wall-clock + token/$ ceiling  → closes G1 + G2
The meter already exists (live usage tailer, subagent rollup, ADR 0010). Wire it to a ceiling: when a run exceeds `maxRunMinutes` or `maxRunTokens`/`maxRunCost`, settle it — escalate to hitl (or awaiting-review with a "hit budget" flag) instead of running forever. This is the single biggest gap and the *cheapest* to close because the measurement is done — you're adding a comparator and a settle path, both of which already exist (`escalate`, `settleFailedOrRetry`).
- **Model after:** SWE-agent auto-submit-on-budget; Copilot 59-min hard stop.
- **Config shape:** mirror `autoRetry`/`continueAttempts` — global default + per-workspace/per-task override. Default generous (e.g. 30–45 min / a token ceiling), operator-tunable.
- **Effort:** ~half a day. Fits the existing `drive.*` config + settle machinery.

### 2. Semantic stuck detector on the Run event stream  → closes G3
Run Events are already the persisted source of truth. Add a lightweight detector over a sliding window (last ~20 events since the last human/steer input) flagging: (a) identical tool-call→result repeated, (b) tool-call→error repeated, (c) agent "monologue" (messages, no tool progress), (d) alternating A/B loops. On trip → inject a **de-duplicated** nudge through the existing steer/continue channel; after N trips → escalate. Catches the "productive-looking spin" a turn-counter can't see.
- **Model after:** OpenHands `StuckDetector` (five patterns, per-pattern thresholds, `_last_nudged_error_event_id` de-dup).
- **Effort:** ~1–2 days. Pure read over `run_events` + reuse of the steer injection path.

### 3. Automated pre-review verification gate ("did it really do it")  → closes G4
Before a run surfaces to the human gate (native) or auto-merges (afk), run an evidence check in the worktree and stamp the result on the card:
- **Cheap tier:** run the repo's own test/lint command (a configured `verifyCmd`, like Conductor's Checks / Copilot's Actions run) — red blocks auto-merge and annotates the review.
- **Rich tier:** a skeptical critic subagent returns CONFIRMED / REFUTED / INCONCLUSIVE with captured evidence, shown on the awaiting-review card so the human reviews a pre-vetted diff.
This extends `isResolved` from "ticket closed?" to "ticket closed *and* the work stands." Cuts reviewer load and catches false-done before merge.
- **Model after:** Sculptor (misleading-behavior checks), Factory Droid Control (verdict + evidence).
- **Effort:** cheap tier ~1 day (config + one worktree command + card field); rich tier is a larger design.

### 4. Bounded self-healing loop on settle-time failures  → closes G5
When the cheap verify (rec 3) fails, don't go straight to awaiting-review/unresolved — pipe the **structured** lint/test error back as the next turn, bounded by a small cap (reuse the continue-budget pattern). This is distinct from `autoRetry` (fresh Run from scratch): it's the *same* run getting the exact error text as its next prompt.
- **Model after:** Aider reflection loop (`max_reflections = 3`); SWE-agent revert-on-lint (measured +3 pts resolution).
- **Effort:** ~1–2 days, and it composes directly with rec 3 (share the verify command).

### 5. Crash-resume via ACP session replay/snapshot (bigger lift, lower priority)  → closes G6
Pair the safe fail-forward with resumability so a restart mid-run doesn't always cost the whole run. Harder because it depends on the harness supporting session resume (ACP `session/load`) and persisting enough turn state; not all harnesses will. Worth scoping, not urgent — the current behavior is *safe*, just wasteful.
- **Model after:** OpenHands event-sourced replay; Codex 12h container cache; Factory `load_session`/`--fork`.

---

## One thing NOT to copy
The field's default completion gate is "surface a PR for a human to review" with **no machine verification** (Copilot, Codex, Cursor, Conductor, Vibe Kanban, Terragon, Devin). Harmonic's ADR-0011 already refuses the weaker version of this ("clean exit = done"). Don't regress toward it. The verifiable, mechanism-level reliability ideas cluster in the **open-source / paper-backed** systems — **OpenHands, SWE-agent, Aider** — mine those hardest.

## Sources
Primary: OpenHands `software-agent-sdk` (StuckDetector, LLMSummarizingCondenser); SWE-agent paper arXiv:2405.15793 (ACI, cost budget, lint-revert +3pts); Aider `base_coder.py` (reflection cap, repo map); Devin docs.devin.ai; Codex developers.openai.com/codex; Copilot docs.github.com; Cursor cursor.com/docs; Factory docs.factory.ai; Sculptor imbue.com/blog; Conductor conductor.build/docs; Vibe Kanban repo + DeepWiki; Terragon terragon-oss. Harmonic: `src/execution/{runner,auto-runner,auto-drive}.ts`, `src/config.ts`, `docs/adr/0011`, `0018`.
