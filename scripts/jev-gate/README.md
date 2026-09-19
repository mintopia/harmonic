# jev-gate — Jev code-quality CI gate

Scores git-changed files with the Jev code-quality model and passes/fails a
verify-stage command based on
[`/home/workspace/reports/jev-thresholds-proposal.md`](../../../reports/jev-thresholds-proposal.md)
(vendored knowledge — read that doc for the *why*; this file is the *how*).

**Determinism note:** the gate *logic* is deterministic given a set of Jev
scores. The scores themselves are not — Jev has run-to-run variance of
roughly ±0.1–0.3 on its 0–4 scale. The policy's 1.0-wide WARN band exists to
absorb that wobble so a re-run practically never flips PASS↔FAIL, but this is
not a hard guarantee for a score sitting exactly on a threshold line.

## Files

| Path | Purpose |
| --- | --- |
| `scripts/jev-gate/cli.ts` | Entrypoint. |
| `scripts/jev-gate/{types,config,glob,git,jev-client,thresholds}.ts` | Implementation modules. |
| `scripts/jev-gate/rubrics.json` | Vendored copy of the 7-category Jev rubric (security-by-exploitability + role-awareness). Self-contained — does not depend on `.claude/skills/jev-code-score` existing on the CI runner. |
| `jev.gate.json` (repo root) | Committed, tunable policy: thresholds, gating vs. advisory categories, path-based role exemptions, source-file filters. Edit this, not the code, to retune the gate. |
| `jev.baseline.json` (repo root, **not created by this change**) | One-way ratchet baseline: `path -> {categories, overall}`. See "Baseline / ratchet" below — the gate runs fine without it, just with a reduced check. |

## Running it

```bash
# Local / ad hoc, from the repo root:
OPENROUTER_API_KEY=... npx tsx scripts/jev-gate/cli.ts --base develop

# CI machine-readable form:
OPENROUTER_API_KEY=... npx tsx scripts/jev-gate/cli.ts --base develop --json
```

### As a Harmonic verify-stage command

Verify commands are `{command, args, cwd, env, timeoutSeconds}` (see
`src/config.ts`'s `verificationCommandSchema`), run in place in the live
worktree. Add this to `verify.task.preMerge.commands` (or `postMerge` /
`epic.preMerge`, per how strict you want the gate):

```json
{
  "command": "npx",
  "args": ["tsx", "scripts/jev-gate/cli.ts", "--json"],
  "env": { "OPENROUTER_API_KEY": "..." },
  "timeoutSeconds": 600
}
```

Non-zero exit fails the Verification Step, same as any other verify command;
the JSON on stdout is the Step's log/output. `--base` is deliberately omitted
above — the default resolution (below) covers the common case; pass it
explicitly if an epic's integration branch needs to be named.

### CLI flags

```
--base <ref>         Base ref to diff against. Default order: $JEV_GATE_BASE,
                      then local "develop", then "origin/develop", then the
                      current branch's own upstream (@{u}). Never falls back
                      to main/origin/main — see AGENTS.md's branching rules.
--repo-root <path>   Working tree to diff/read files from (default: cwd)
--config <path>      jev.gate.json path (default: <repo-root>/jev.gate.json)
--rubrics <path>     rubrics.json path (default: vendored copy next to this script)
--baseline <path>    jev.baseline.json path (default: <repo-root>/<config.baselinePath>)
--concurrency <n>    Parallel Jev calls (default: config.defaultConcurrency, 8)
--json               Emit structured JSON to stdout (default: human report)
--dry-run            Classify/role-map changed files, skip Jev calls (no API key needed)
--signoff <p::cat>   Acknowledge a low-confidence FAIL (repeatable); or $JEV_GATE_SIGNOFF
                      as a comma-separated list of "path::category" tokens
--help, -h
```

Progress ("N changed, M to score", per-file verdict as it lands) always goes
to stderr, so it's safe to redirect stdout to a file in either mode.

### Environment

| Var | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | Required unless `--dry-run`. |
| `JEV_PROVIDER` | `openrouter` (default) or `typesafe`. |
| `JEV_MODEL` / `JEV_URL` | Override the model slug / endpoint. |
| `TYPESAFE_API_KEY` | Required when `JEV_PROVIDER=typesafe`. |
| `JEV_GATE_BASE` | Default `--base` when not passed on the CLI. |
| `JEV_GATE_SIGNOFF` | Comma-separated `path::category` sign-off tokens. |

### Exit codes

`0` = gate passed. `1` = gate failed (at least one file `FAIL`/`ERROR`, or an
unacknowledged `NEEDS_SIGNOFF`). `2` = usage/setup error (bad args, missing
API key, git/config failure) — distinct from `1` so CI can tell "the gate
said no" from "the gate couldn't run".

## What it implements (policy → code)

- **Per-category gating, not overall-only** (proposal §1): `complexity_clean_code`,
  `code_smells`, `duplication`, `testability`, `error_handling` gate; `security`
  and `comments` are advisory-only and can never fail the build (`thresholds.ts`
  `evaluateCategory`). A low `security` score is surfaced as a "flagged for
  human security review" advisory note, never a verdict.
- **Zones**: FAIL `<1.5`, WARN `1.5–<2.5`, PASS `>=2.5` per category; overall
  FAIL `<2.0` (50/100), WARN `2.0–<2.4` (proposal §2). Both are config-driven
  in `jev.gate.json`.
- **Confidence as a second axis** (proposal §3): a category FAIL only blocks
  when `confidence >= 0.6`; below that it becomes `NEEDS_SIGNOFF`, which still
  fails the gate (exit 1) until cleared with `--signoff`/`$JEV_GATE_SIGNOFF` —
  this is the CI-side stand-in for the proposal's "human reviewer clears the
  flag" step. Confidence never upgrades a score.
- **Role exemptions** (proposal §4): `jev.gate.json`'s `roles` array, matched
  in order (first match wins), suppresses listed categories from gating for
  stories/tests/fixtures/mocks/migrations, and skips `.d.ts` and
  generated/vendored files entirely (never sent to Jev). Each matched file
  gets a `role_hint` attached to the Jev call, mirroring `jev_score.py`'s
  `build_state()`.
- **Diff mode + ratchet** (proposal §5): only files changed vs. the merge-base
  are scored. If `jev.baseline.json` exists and has an entry for a file, a
  gating category also fails if it drops `>=0.5` vs. baseline, or the file's
  overall drops `>=0.2` (mean units, `>=5/100`) — independent of the absolute
  zone check, so a still-PASSing-but-regressed file still blocks. **This
  change does not create `jev.baseline.json`** (generating one needs a full
  scored run of the repo, out of scope here); with no baseline file the gate
  logs a note and degrades gracefully to the absolute new-file check only, per
  the task's explicit instruction. Baseline *write-back* (updating the file on
  merge) is not implemented — it's a separate post-merge step, not part of a
  verify-stage gate.
- **Both file and diff sent to Jev**: each Jev call's `state` carries the
  file's full current content *and* its diff vs. the merge-base, so the model
  sees what changed as well as the end state.
- **Bounded concurrency + retry/backoff**: `jev-client.ts`'s `runPool` mirrors
  `jev_score.py`'s `ThreadPoolExecutor(max_workers=concurrency)`; `callJev`
  retries up to 5 times on 429/5xx, honouring `Retry-After`, exponential
  backoff otherwise.

## What is NOT implemented, and why

- **Baseline write-back / generation.** Proposal §5 describes updating
  `jev.baseline.json` on merge to `develop`, "only if improved or held". That
  is a separate post-merge job (needs a full-repo scored run), not something a
  per-PR verify-stage gate should do. This script only *reads* a baseline if
  one exists.
- **The PR-label escape hatch** (`jev-gate-override`, proposal §5). This
  script has no PR/label integration — it only knows git and the filesystem.
  `--signoff` is the closest equivalent for the one case the proposal treats
  as blocking-until-human (`NEEDS_SIGNOFF`); a genuine ratchet-regression
  override would need to be layered on by whatever CI system invokes this
  (e.g. skip the command, or pass `--baseline /dev/null` to disable the ratchet
  for that run).
- **Rollout phasing** (proposal §6: shadow → new-file-only → ratchet →
  steady-state). This script always enforces the full policy (absolute +
  ratchet-when-available). Phasing it is a matter of *how* it's wired into
  `verify.*.commands` (e.g. start in a non-blocking CI job that only comments,
  then promote to a real verify command), not something the script itself
  needs to know about.
- **Anti-inflation cross-check on ratchet jumps** (proposal §7, point 6:
  flag an implausible +1.5 jump for human confirmation before it locks in as
  the new baseline). Not applicable without baseline write-back (above); would
  belong in that future job, not here.
