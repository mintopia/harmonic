# Copilot support

Status: ready-for-human

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

Fill in the Copilot Harness Adapter from issue 25's findings, to full
parity with Claude: Runs execute over ACP, stream events, hit the review
gate, the per-Task model is honored (observed model surfaced on
contradiction), and Usage carries a per-model breakdown via a session-log
Usage Collector where the spike proved one derivable.

Scope, all shaped by spike findings:

- **Spawn tweaks**: the verified model-pinning mechanism; quirk
  workarounds. Correct `defaultConfig()` if the spike contradicts
  `copilot --acp` or the shipped model list.
- **Usage Collector**: per-model breakdown from Copilot's session log with
  the standard flush-race retry semantics — or, if the spike classified
  per-model usage as underivable, honest degradation to ACP aggregate
  totals (never a fake breakdown), with the parity gap recorded as a
  follow-up.
- **AI Units**: if the spike found per-Run consumption observable, add the
  optional Usage field and show it on the run detail as actual spend
  alongside Cost — a separate figure, never folded into Cost (decision Q4;
  see CONTEXT.md "AI Unit").
- **MCP registration**: ACP `session/new` `mcpServers` if verified;
  env-var fallback otherwise.
- **Legible auth failure**: an unauthenticated spawn fails the Run with a
  recognizable reason.
- **Pricing**: ensure `DEFAULT_PRICES` covers the models Copilot's router
  actually serves (spike: `claude-haiku-4.5`, `gpt-5-mini` observed) so
  Copilot runs stop flagging Cost incomplete. Cost stays uniformly
  API-equivalent for Copilot (decision Q4). (Reworded per spike — the
  `gpt-5.2` guess doesn't exist; Copilot is auto-model, priced per
  observed serving model.)
- If the model is not pinnable: collapse the Copilot `models` list to its
  verified default and fix the Task form display (Q7).

## Acceptance criteria

- [ ] A real Copilot Task runs end-to-end: ready → running → awaiting-review, with streamed session updates in the run detail
- [ ] The Task's model demonstrably reaches Copilot, and a contradicting observed model is surfaced on the run
- [ ] Usage on a finished Copilot run matches the spike's classification: per-model breakdown, or honest aggregate-only with the gap filed as a follow-up
- [ ] Cost on a Copilot run prices its observed serving models with no incomplete flag (reworded per spike: auto-model harness; `gpt-5.2` never existed)
- [ ] AI Units appear on the run detail as actual spend iff the spike proved them observable; Cost aggregates are unchanged either way
- [ ] The spawned Copilot agent can call AgentDeck's MCP tools using its Run Key with zero operator setup
- [ ] An unauthenticated Copilot spawn fails the Run with a legible reason
- [ ] Tests cover the Copilot Usage Collector (or aggregate-only path) against captured fixtures from the spike

## Blocked by

- Issue 25 (spike findings)
- Issue 23 (adapter seam)

## Comments

2026-07-14 (agent): Issue 25's spike is done — **go, with adjustments**
(full detail in `.scratch/agentdeck-v1/spike-findings-copilot-acp.md`):

- Model is **pinnable via ACP `session/set_model` on plans with model
  selection** (re-checked 2026-07-14 on an entitled login, captures
  12–13; the first probe account was auto-only, where the same call is
  accepted and silently overridden — actual-model verification stays
  load-bearing). Requirements that fall out:
  - a post-`session/new` **set_model hook** on the adapter seam
    (additive), sent for *every* Copilot run — an unpinned session
    inherits the operator's persisted `settings.json` model, not `auto`;
  - never pass `--model` (it falsifies `session/new`'s reported
    `currentModelId` without changing the session);
  - source the Task form's model list from `session/new`'s
    `models.availableModels` (live, account-accurate, carries the
    AI-credit multiplier per model; absent on auto-only plans → form
    collapses to `auto`);
  - treat `auto` as matching any observed model in the `model_mismatch`
    check; a pinned model that *doesn't* match observed means the plan
    ignored the pin — surface that mismatch.
- Usage Collector source is the **OTel file exporter**, not the
  ACP-session event log (which has no token counts) and not the prompt
  result (bare). Spawn with `COPILOT_OTEL_FILE_EXPORTER_PATH` at a
  per-run file — needs `spawnEnv` to receive the run workdir (additive
  seam change); `sessionLogFile()` derives the same path from `cwd`.
  Parse `chat` spans, aggregate by `gen_ai.response.model`; cache fields
  come from the omit-when-zero `gen_ai.usage.cache_read.input_tokens` /
  `cache_creation.input_tokens` attributes and `input_tokens` is *total*
  input (uncached = total − both). AI Units are observable per-Run
  (`github.copilot.nano_aiu` per span): ship the optional Usage field.
- MCP `session/new` HTTP + bearer verified end to end; auth failure is
  already legible (`-32000 "Authentication required"`).
- Also set `COPILOT_AUTO_UPDATE=false` in `spawnEnv` (the CLI updated
  itself mid-spike) and consider `--disable-builtin-mcps`.

2026-07-14 (agent): Implemented. All acceptance criteria verified, the
first one against the real CLI (1.0.70, entitled login): a real Copilot
Task ran ready → running → awaiting-review with streamed updates; the
`claude-haiku-4.5` pin was honored (observed model matched, no
`model_mismatch`); Usage carried the per-model breakdown with the cache
split off the OTel file exporter plus **AI Units 6.73** on the run detail
alongside Cost $0.07 (complete, no flag); the agent called
`agentdeck-list_tasks` over MCP with its Run Key and answered correctly.

Implementation notes:

- Seam changes (all additive): `spawnEnv` now takes `{model, cwd,
  sessionLogDir}`; new optional `sessionModelId` hook → the Runner sends
  ACP `session/set_model` after `session/new` (every Copilot run, `auto`
  included); `modelsFromSessionLog` gained a `sessionId` param (Copilot's
  OTel file is cwd-keyed and shared in direct mode — spans filter on
  `gen_ai.conversation.id`); `ModelUsage.aiUnits?` rides Usage end to end.
- `observedModelMismatch` treats a task pinned to `auto` as matching any
  observed model (the router's choice is information, not a warning).
- `defaultConfig()`: `copilot --acp --disable-builtin-mcps`,
  `defaultModel: 'auto'`, models = the capture-12 entitled list **minus
  `gemini-*`/`mai-*`** — those have no API-equivalent published rate, and
  a shipped model must have a shipped price ("never incomplete out of the
  box"). Operators who want them add the id plus a `prices` entry
  (documented in `docs/copilot.md`, new operator notes: keychain auth,
  bad-env-token fallback, plugin leak-in, plan-dependent pinning).
- `DEFAULT_PRICES` gained the dotted Copilot Claude ids, `gpt-5-mini`
  (observed router candidate), and `gpt-5.3-codex`; the pricing invariant
  test exempts `auto` (a router — Usage only ever attributes tokens to
  concrete serving models).
- Bonus observed on 1.0.70: `agent_thought_chunk`s now stream (the spike
  saw none on 1.0.69); the event stream already renders them.
- Follow-up decision left open (spike Q6): whether Runs should see the
  operator's `~/.copilot` plugins — the verify run confirmed they leak in
  today. Documented, not changed.
- Follow-up not taken (the spike's "or better" option): sourcing the Task
  form's model list live from `session/new`'s `availableModels` (account-
  accurate, carries the AI-credit multiplier, collapses to `auto` on
  auto-only plans). Needs a probe session or a post-run feedback loop into
  config — a slice of its own; the shipped list is the verified static
  snapshot meanwhile.
