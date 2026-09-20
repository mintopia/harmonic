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
| `scripts/jev-gate/render-html.ts` | Renders a baseline to a self-contained HTML report (written by default; `--no-html` skips it). |
| `scripts/jev-gate/aggregate.ts` | Flattens each category's sub-questions into the flat map sent to Jev, and folds sub-answers back into one category score (`min` or `mean`). |
| `scripts/jev-gate/rubrics.json` | The 8-category Jev rubric, each category split into narrow sub-questions (in-file signals only, role-aware). Its `_meta.authoring` lists the measured rules for writing a question Jev answers with high confidence. Self-contained — does not depend on `.claude/skills/jev-code-score` existing on the CI runner. |
| `jev.gate.json` (repo root) | Committed, tunable policy: thresholds, gating vs. advisory categories, path-based role exemptions, source-file filters. Edit this, not the code, to retune the gate. |
| `jev.baseline.json` (repo root) | One-way ratchet baseline: `path -> {categories, confidences, subs, decidedBy, overall}`. Generate/regenerate it with `--write-baseline`. The gate runs fine without it, just with a reduced (absolute-only) check. |

### Sub-questions and aggregation

Each rubric category is no longer a single Jev question — `rubrics.json` nests
narrow sub-questions under it (e.g. `security` has `injection`,
`secrets_crypto`, `auth_fail_open`), because Jev reports a
far more peaked (confident) distribution when a question can be settled from
one dimension. `aggregate.ts`'s `toJevQuestions` flattens every sub-question
to a `category.sub` id before the Jev call; `aggregateCategory` folds the
per-id answers back into one category score per the category's `aggregate`:

- `min` — the category score/confidence is its lowest-scoring sub-question's
  answer (ties broken by the lower confidence). The gate's blocking-reason and
  advisory text names this sub-question, e.g.
  `security: FAIL (1.2/4, confidence 0.81, decided by injection)`.
- `mean` — the category score/confidence is the arithmetic mean across its
  sub-questions; no single sub-question "decides" it.

A missing or non-numeric sub-answer counts as score 0, confidence 0, mirroring
the previous single-question behaviour. `CategoryResult.subs` and
`BaselineEntry.subs` carry the raw per-sub answers through to the CLI output
and baseline file; the HTML report's per-file detail row lists them per
category. `BaselineEntry.decidedBy` records, per `min` category, which sub-question
decided the score; the report bolds that one.

## Running it

```bash
# Bash-runnable wrapper (cds to repo root, uses local tsx). From anywhere:
OPENROUTER_API_KEY=... ./scripts/jev-gate.sh --base develop
OPENROUTER_API_KEY=... ./scripts/jev-gate.sh --base develop --json   # CI form

# Or via npm:
OPENROUTER_API_KEY=... npm run jev:gate -- --base develop

# Seed / regenerate the whole-project baseline (the ratchet floor):
OPENROUTER_API_KEY=... ./scripts/jev-gate.sh --write-baseline        # or: npm run jev:baseline
OPENROUTER_API_KEY=... ./scripts/jev-gate.sh --write-baseline --no-html # skip jev.baseline.html
./scripts/jev-gate.sh --write-baseline --dry-run                     # list files, no API key, writes nothing

# Render the EXISTING baseline to HTML (no scoring, no API key):
./scripts/jev-gate.sh --html --dry-run                               # writes jev.baseline.html next to the json
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
--mode <m>           "advisory" (report only, always exit 0) or "enforcing"
                      (exit 1 on a failing verdict). Default: config.mode,
                      overridable by $JEV_GATE_MODE.
--write-baseline     Score the whole tracked project into --baseline (ratchet seed)
--json               Emit structured JSON to stdout (default: human report)
--no-html            Skip the HTML report (written by default next to the baseline:
                      jev.baseline.html on --write-baseline, jev.baseline.change.html
                      on a gate run; both gitignored)
--html               With --dry-run: re-render the existing baseline, no Jev calls
--dry-run            Resolve files/roles, skip Jev calls (no API key needed);
                      with --write-baseline, lists files and writes nothing
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
| `JEV_GATE_MODE` | `advisory` or `enforcing`; overrides `config.mode`, below `--mode`. |
| `JEV_GATE_SIGNOFF` | Comma-separated `path::category` sign-off tokens. |

### Exit codes

`0` = gate passed. `1` = gate failed (at least one file `FAIL`/`ERROR`, or an
unacknowledged `NEEDS_SIGNOFF`). `2` = usage/setup error (bad args, missing
API key, git/config failure) — distinct from `1` so CI can tell "the gate
said no" from "the gate couldn't run".

## What it implements (policy → code)

- **Per-category gating, not overall-only** (proposal §1): which axes gate is
  config-driven via `jev.gate.json`'s `gatingCategories` / `advisoryCategories`
  (`thresholds.ts` `evaluateCategory` — a category only blocks when it is in
  `gatingCategories` and not role-exempt). Anything left in `advisoryCategories`
  keeps its true zone for display but can never produce a FAIL verdict; a low
  `security` score there is surfaced as a "flagged for human security review"
  advisory note. **This workspace's `jev.gate.json` gates all 8 axes, including
  `security` and `comments`** — see `docs/jev-gate.md` for the reliability
  caveat that comes with gating `security`.
- **Zones**: FAIL `<1.5`, WARN `1.5–<2.5`, PASS `>=2.5` per category; overall
  FAIL `<2.0` (50/100), WARN `2.0–<2.4` (proposal §2). Both are config-driven
  in `jev.gate.json`.
- **Confidence as a second axis** (proposal §3): confidence is the model's own
  certainty in its verdict — the rubric never instructs or nudges it. A category
  FAIL only blocks when `confidence >= 0.5`; below that it becomes
  `NEEDS_SIGNOFF`, which still fails the gate (exit 1) until cleared with
  `--signoff`/`$JEV_GATE_SIGNOFF` — the CI-side stand-in for the proposal's
  "human reviewer clears the flag" step. Confidence never upgrades a score.
- **Role exemptions** (proposal §4): `jev.gate.json`'s `roles` array, matched
  in order (first match wins), makes a matched file's `exempt` categories not
  asked at all for stories/tests/fixtures/mocks/migrations — no sub-question
  for them reaches Jev, and they're absent from `FileResult.categories` /
  the baseline entry, contributing nothing to `overall` (they used to still be
  sent and scored, just excluded from gating; a role's `exempt` list is now
  the honest "this role makes the question meaningless" signal, not "score it
  but ignore the answer"). A role's `skip: true` still skips every category
  and sends nothing to Jev; a role whose `exempt` covers all 8 categories is
  treated the same way (nothing left to ask). Each matched, non-fully-exempt
  file gets a `role_hint` attached to the Jev call, mirroring `jev_score.py`'s
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

- **Baseline generation** is now implemented: `--write-baseline` scores every
  tracked, in-scope source file (role skips/exemptions and size limits apply)
  and writes `jev.baseline.json` as `path -> {categories, overall}`. It
  overwrites (does not merge), so run it on a known-good commit.
- **Baseline write-back on merge** (proposal §5: update the baseline on merge to
  `develop`, "only if improved or held") is still not automated — a per-PR
  verify-stage gate should not rewrite the ratchet floor. Re-run
  `--write-baseline` deliberately when you want to move the floor.
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
