# Jev quality gate

A deterministic, config-driven quality gate (`scripts/jev-gate.ts`, invoked via `npm run jev:gate`) that scores git-changed source files against TypeSafe's Jev code-quality model across 7 categories, applies committed thresholds and role-based exemptions, and exits 0 (pass/report) or non-zero (enforcing-mode failure). The thresholds and phase strategy were originally proposed as part of the Jev code-quality remediation initiative (issue #647); this doc summarizes the operational parts, the full rationale lives in the threshold proposal referenced from that issue.

## What it gates and what it does not

The gate blocks only on 5 reliable axes: `complexity_clean_code`, `code_smells`, `duplication`, `testability`, `error_handling`. Two axes — `security` and `comments` — are **advisory only** and can never auto-pass or auto-fail anything. Jev's security axis was calibrated as unreliable: it both misses real vulnerabilities and over-flags benign code, with no exploitability model. A low advisory score is a flag for a human to look, never a verdict.

## Running it locally

```bash
npm run jev:gate -- --diff                       # gate changed files vs the default base (develop)
npm run jev:gate -- --diff --base epic/foo       # explicit base ref
npm run jev:gate -- src/a.ts src/b.ts            # explicit file list (dry run)
npm run jev:gate -- --write-baseline $(git ls-files 'src/**/*.ts')   # populate the baseline (needs OPENROUTER_API_KEY)
npx tsx scripts/jev-gate.ts --diff --out /tmp/jev.json
```

The gate needs `OPENROUTER_API_KEY` in the environment to make real calls; without it, the gate reports "skipped: no API key" and exits 0 rather than failing — safe to run/wire anywhere, it just won't do anything until a key is configured.

Two output streams: a JSON report on stdout (or `--out <path>`), and a human-readable per-file summary on stderr (so the JSON stays parseable even when piped).

Exit codes:

- `0` — not a blocking failure (includes: advisory mode always, all-pass, no API key, `--write-baseline`)
- `1` — enforcing-mode blocking failure
- `2` — bad CLI invocation (unknown flag, conflicting flags)

The "no API key" / "unresolvable base" / "git failure" cases above only exit 0 when `jev.gate.json`'s `onInfrastructureError` field (`"skip" | "fail"`, default `"skip"` in the committed config) is left at `"skip"`. If an operator sets it to `"fail"`, the same infrastructure problem becomes a blocking exit `1` in enforcing mode instead of a silent skip.

## Wiring it into a workspace's verify stage

Harmonic's verify stage (`verify.task.preMerge.commands[]`) is configured per-workspace via the Harmonic settings UI, which is runtime database state, not a file in this git repo — so wiring the gate in is an operator action, not something this repo's code can do on its own.

An operator wiring in the gate types these exact `VerificationCommand` fields into the settings UI:

- **Command**: `npm`
- **Args**: `run`, `--silent`, `jev:gate`, `--`, `--diff`
- **Cwd**: (leave blank — repo root)
- **Env**: (leave blank — see the API key note below)
- **Timeout**: `900` seconds (a 600s default can be tight for a larger change scored at low concurrency)

**API key placement**: do NOT put `OPENROUTER_API_KEY` in the verifier's own `Env` map — that stores it in plaintext in Harmonic's settings/exports. Instead set it on the Harmonic service's own process environment (e.g. the systemd unit's `EnvironmentFile`, or however this deployment manages service env vars) — verify commands already inherit the full Harmonic daemon environment (minus `HARMONIC_API_KEY`/`HARMONIC_MCP_URL`, which are always stripped for every verifier).

This repo's own shipped default config (`src/baseline.yaml`, `verify.task.preMerge.commands: []`) is intentionally NOT being changed by this work — that file is the out-of-the-box default for every Harmonic install everywhere, most of which have no `OPENROUTER_API_KEY` and don't ship `scripts/jev-gate.ts` in their npm package (only `dist/` and `drizzle/` are published). The gate is opt-in, wired per-workspace by an operator who wants it — starting with this repo's own Harmonic-on-Harmonic workspace, if the team chooses to.

## Rollout phases

Advancing a phase is a judgment call once the advisory reports look trustworthy (low false-positive rate) — not automated by this script.

| Phase | Mode | Config | Behavior |
|-------|------|--------|----------|
| 0 (Advisory) | `"mode": "advisory"` | — | Never blocks, only reports. Watch the JSON reports for false-positive rate. |
| 1 (New files) | `"mode": "enforcing"`, `enforce: { newFileAbsolutes: true, modifiedFileAbsolutes: false, ratchet: false }` | — | Only newly-added files can block; existing files stay advisory. |
| 2 (Ratchet) | `"mode": "enforcing"`, `enforce: { newFileAbsolutes: true, modifiedFileAbsolutes: false, ratchet: true }` | `jev.baseline.json` populated | Same as Phase 1, but modified files can now block on regression. |
| 3 (Full) | `"mode": "enforcing"`, `enforce: { newFileAbsolutes: true, modifiedFileAbsolutes: true, ratchet: true }` | `jev.baseline.json` populated | All files enforce absolute thresholds and ratchet. |

## Flipping advisory to enforcing

One-line edit: change `"mode"` in `jev.gate.json` from `"advisory"` to `"enforcing"` (plus the relevant `enforce` booleans for the target phase). You can dry-run a flip without committing it via `--mode enforcing` on the CLI.

> **Warning**: In enforcing mode a gate FAIL fails the whole Harmonic Attempt and burns an attempt counter — don't flip the switch without having read a reasonable stretch of advisory-mode reports first.

## The baseline

`jev.baseline.json` (repo root) ships seeded empty (`"files": {}`) because there's no `OPENROUTER_API_KEY` available to run a real full-repo score right now — inventing scores would be worse than having none. Until it's populated, every changed file is treated as "new" and judged only on absolute thresholds (which is exactly Phase 0/1 behavior anyway).

Populate it later with `npm run jev:gate -- --write-baseline <file-list>` once a key is available. This is a deliberate, reviewed commit — the gate never writes the baseline automatically as a side effect of a normal run.

## Escape hatch (convention, not tooling)

A knowingly-accepted gate failure should carry a label + written justification on the PR/Attempt (mirroring Harmonic's existing escalation/Accept norms), rather than just being silently overridden. This is a convention this ticket does not build tooling for.

## Non-goals

This work does not:

- (a) Change Harmonic's shipped default `verify.task.preMerge.commands` in `src/baseline.yaml`.
- (b) Auto-write the baseline back on merge.
- (c) Add a CI job (possible later, but needs a repo secret for the API key).
- (d) Support per-category threshold overrides beyond what's in `jev.gate.json`.
