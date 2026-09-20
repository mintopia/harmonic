# Jev quality gate

A deterministic, config-driven quality gate (`scripts/jev-gate/cli.ts`, run via `./scripts/jev-gate.sh` or `npm run jev:gate`) that scores git-changed source files against TypeSafe's Jev code-quality model across 8 categories, applies committed thresholds and role-based exemptions, and exits 0 (pass / advisory) or non-zero (enforcing-mode failure or setup error). The thresholds and phase strategy were originally proposed as part of the Jev code-quality remediation initiative (issue #647); this doc summarizes the operational parts, the full rationale lives in the threshold proposal referenced from that issue.

## What it gates

All 8 axes gate in this workspace: `complexity_clean_code`, `code_smells`, `testability`, `error_handling`, `security`, `comments`, `concurrency_and_idempotency`, and `ai_slop`. Gating vs. advisory is set purely by `jev.gate.json`'s `gatingCategories` / `advisoryCategories` — move a category between those lists to change what can block. (`duplication` was dropped 2026-09-19: it needs cross-file context the per-file gate cannot supply, so its scores were never decidable.)

> **Note on `security`.** Jev's security axis has no exploitability model and is calibrated as noisy: it both misses real vulnerabilities and over-flags benign code. This workspace deliberately gates on it anyway (a low score blocks or, at low confidence, requires a human sign-off). Expect false positives; use `--signoff` / advisory mode during rollout, and keep a human in the loop rather than trusting the score as a verdict.

Role exemptions (`roles` in `jev.gate.json`) suppress specific axes for tests, mocks, fixtures, stories, and migrations, and skip `.d.ts` / generated files entirely.

## Running it locally

```bash
./scripts/jev-gate.sh                             # gate changed files vs the default base (develop)
./scripts/jev-gate.sh --base epic/foo             # explicit base ref
./scripts/jev-gate.sh --json > /tmp/jev.json      # machine-readable report on stdout
./scripts/jev-gate.sh --write-baseline            # score the WHOLE project into jev.baseline.json
./scripts/jev-gate.sh --write-baseline --dry-run  # list what would be scored; no API key, writes nothing
npm run jev:gate -- --base epic/foo               # same via npm
npm run jev:baseline                              # = --write-baseline
```

The gate needs `OPENROUTER_API_KEY` (or `TYPESAFE_API_KEY` when `JEV_PROVIDER=typesafe`) to make real calls. Without a key it exits `2` (setup error), not `0` — so an unkeyed enforcing gate fails loudly rather than silently passing. Use `--dry-run` to resolve files/roles with no key.

The human report goes to stdout (or `--json` for the structured form); per-file progress goes to stderr, so the report stays parseable when piped.

Exit codes:

- `0` — gate passed, advisory mode (any verdict), or `--write-baseline` succeeded
- `1` — enforcing-mode failing verdict (a `FAIL`, an `ERROR`, or an unacknowledged `NEEDS_SIGNOFF`)
- `2` — setup error (bad flag, missing API key, git/config failure) — distinct from `1` so CI can tell "the gate said no" from "the gate couldn't run"

## Advisory vs. enforcing

`mode` (in `jev.gate.json`, overridable by `--mode advisory|enforcing` or `$JEV_GATE_MODE`) controls whether a failing verdict actually breaks the build:

- **advisory** — scores and reports everything, then exits `0` regardless of verdict. Use it for shadow rollout: watch the reports for the false-positive rate before you let it block.
- **enforcing** — a failing verdict exits `1`.

Low-confidence FAILs (below `thresholds.confidence.blockingMin`) become `NEEDS_SIGNOFF`, which still fails an enforcing run until an operator clears each one with `--signoff <path>::<category>` (repeatable) or a comma-separated `$JEV_GATE_SIGNOFF`.

This workspace ships `"mode": "advisory"` so the newly-gating `security`/`comments` axes are observed before they block. Flip to `"enforcing"` (one-line edit, or `--mode enforcing` to try without committing) once the reports look trustworthy.

> **Warning**: in enforcing mode a gate FAIL fails the whole Harmonic Attempt and burns an attempt counter — read a reasonable stretch of advisory reports first.

## Wiring it into a workspace's verify stage

Harmonic's verify stage (`verify.task.preMerge.commands[]`) is configured per-workspace via the Harmonic settings UI, which is runtime database state, not a file in this git repo — so wiring the gate in is an operator action, not something this repo's code can do on its own.

An operator wiring in the gate types these exact `VerificationCommand` fields into the settings UI:

- **Command**: `npm`
- **Args**: `run`, `--silent`, `jev:gate`
- **Cwd**: (leave blank — repo root)
- **Env**: (leave blank — see the API key note below)
- **Timeout**: `900` seconds (600s can be tight for a large change scored at low concurrency)

**API key placement**: do NOT put `OPENROUTER_API_KEY` in the verifier's own `Env` map — that stores it in plaintext in Harmonic's settings/exports. Instead set it on the Harmonic service's own process environment (e.g. the systemd unit's `EnvironmentFile`) — verify commands inherit the full Harmonic daemon environment (minus `HARMONIC_API_KEY`/`HARMONIC_MCP_URL`, always stripped for every verifier).

This repo's shipped default config (`src/baseline.yaml`, `verify.task.preMerge.commands: []`) is intentionally NOT changed by this work — that file is the out-of-the-box default for every Harmonic install, most of which have no `OPENROUTER_API_KEY` and don't ship `scripts/` in their npm package (only `dist/` and `drizzle/` are published). The gate is opt-in, wired per-workspace by an operator who wants it.

## Rollout phases

Advancing a phase is a judgment call once the advisory reports look trustworthy (low false-positive rate) — not automated by this script.

| Phase | How | Behavior |
|-------|-----|----------|
| 0 (Shadow) | `"mode": "advisory"` | Never blocks, only reports. Watch the reports for false positives. |
| 1 (Absolute) | `"mode": "enforcing"`, no populated `jev.baseline.json` | Every changed file blocks on absolute thresholds (and low-confidence FAILs need sign-off). |
| 2 (Ratchet) | `"mode": "enforcing"` + populated `jev.baseline.json` | Same as Phase 1, plus a file that regresses ≥ `ratchet.categoryDrop` / `ratchet.overallDrop` vs. its baseline entry also blocks. |

## The baseline

`jev.baseline.json` (repo root) is the one-way ratchet floor: `path -> {categories, overall}`. It ships empty (`{}`). Until it's populated, every changed file is judged on absolute thresholds only (Phase 0/1 behavior).

Populate or refresh it with `./scripts/jev-gate.sh --write-baseline` (or `npm run jev:baseline`) once a key is available — this scores every tracked, in-scope source file (role skips/exemptions and size limits apply) and overwrites the file. It's a deliberate, reviewed commit; the gate never writes the baseline as a side effect of a normal run.

## Escape hatch (convention, not tooling)

A knowingly-accepted gate failure should carry a label + written justification on the PR/Attempt (mirroring Harmonic's existing escalation/Accept norms), rather than being silently overridden. `--signoff` is the concrete mechanism for the `NEEDS_SIGNOFF` case; a ratchet-override is done by not wiring the gate as blocking for that run (or `--baseline /dev/null` to disable the ratchet).

## Non-goals

This work does not:

- (a) Change Harmonic's shipped default `verify.task.preMerge.commands` in `src/baseline.yaml`.
- (b) Auto-write the baseline back on merge.
- (c) Add a CI job (possible later, but needs a repo secret for the API key).
- (d) Support per-category threshold overrides beyond what's in `jev.gate.json`.
