#!/usr/bin/env -S npx tsx
/**
 * Jev CI gate — scores git-changed files against the Jev code-quality model
 * and passes/fails per /home/workspace/reports/jev-thresholds-proposal.md.
 * Meant to run as a `verify` stage command (task.preMerge / task.postMerge /
 * epic.preMerge — see CONTEXT.md's "Verification" entry); see README.md next
 * to this file for the exact command to configure and the config/env/exit
 * code reference.
 *
 * DETERMINISM NOTE: the *gate logic* here is deterministic given a set of Jev
 * scores — same scores in, same verdict out, every time. Jev's scores
 * themselves are not: run-to-run variance is ~±0.1-0.3 on the 0-4 scale. The
 * threshold policy's 1.0-wide WARN band exists specifically to absorb that
 * wobble (see proposal §2.1) so a re-run practically never flips PASS<->FAIL,
 * but it is not mathematically guaranteed for a file sitting exactly on a
 * line. Treat "deterministic" as "the policy is deterministic", not "the
 * scores are exact measurements".
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateCategory, toJevQuestions } from './aggregate.js';
import { loadGateConfig, loadRubrics } from './config.js';
import { changedFiles, fileDiff, GitError, mergeBase, resolveBaseRef, trackedFiles } from './git.js';
import { classifyRole, isInSkipDir, isSourceFile } from './glob.js';
import { callJev, JevFileTooBigError, resolveProviderConfig, runPool, type JevState } from './jev-client.js';
import { renderBaselineHtml } from './render-html.js';
import {
  advisoryNotes,
  blockingReasons,
  evaluateCategory,
  evaluateOverall,
  verdictFromReasons,
  warnNotes,
} from './thresholds.js';
import {
  ALL_CATEGORIES,
  type Baseline,
  type BaselineEntry,
  type BaselineFile,
  type BaselineMeta,
  type CategoryId,
  type CategoryResult,
  type FileResult,
  type GateConfig,
  type GateMode,
  type GateResult,
  type GateSummary,
  type JevUsage,
  type SubAnswers,
} from './types.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

interface CliOptions {
  base: string | undefined;
  repoRoot: string;
  configPath: string;
  rubricsPath: string;
  baselinePath: string | undefined;
  concurrency: number | undefined;
  mode: GateMode | undefined;
  json: boolean;
  dryRun: boolean;
  writeBaseline: boolean;
  html: boolean;
  signoffs: string[];
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    base: undefined,
    repoRoot: process.cwd(),
    configPath: '',
    rubricsPath: join(SCRIPT_DIR, 'rubrics.json'),
    baselinePath: undefined,
    concurrency: undefined,
    mode: undefined,
    json: false,
    dryRun: false,
    writeBaseline: false,
    html: false,
    signoffs: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--base': {
        const val = argv[++i];
        if (!val) throw new Error('jev-gate: --base needs a ref argument');
        opts.base = val;
        break;
      }
      case '--repo-root':
        opts.repoRoot = resolve(argv[++i] ?? '.');
        break;
      case '--config':
        opts.configPath = resolve(argv[++i] ?? '');
        break;
      case '--rubrics':
        opts.rubricsPath = resolve(argv[++i] ?? '');
        break;
      case '--baseline':
        opts.baselinePath = resolve(argv[++i] ?? '');
        break;
      case '--concurrency': {
        const raw = argv[++i];
        const n = raw === undefined ? NaN : Number(raw);
        if (!Number.isFinite(n) || n < 1) throw new Error(`jev-gate: --concurrency needs a positive number, got "${raw ?? ''}"`);
        opts.concurrency = n;
        break;
      }
      case '--mode': {
        const raw = argv[++i];
        if (raw !== 'advisory' && raw !== 'enforcing') {
          throw new Error(`jev-gate: --mode must be "advisory" or "enforcing", got "${raw ?? ''}"`);
        }
        opts.mode = raw;
        break;
      }
      case '--json':
        opts.json = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--write-baseline':
        opts.writeBaseline = true;
        break;
      case '--html':
        opts.html = true;
        break;
      case '--signoff':
        opts.signoffs.push(argv[++i] ?? '');
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`jev-gate: unrecognized argument "${arg}" (--help for usage)`);
    }
  }
  if (!opts.configPath) opts.configPath = join(opts.repoRoot, 'jev.gate.json');
  return opts;
}

const HELP = `jev-gate — Jev code-quality CI gate for changed files

Usage:
  jev-gate [--base <ref>] [--json] [options]        # gate changed files
  jev-gate --write-baseline                         # score the whole project into jev.baseline.json

Options:
  --base <ref>         Base ref to diff against (default: $JEV_GATE_BASE, else
                        "develop" / "origin/develop" / the current branch's
                        upstream — never "main"/"origin/main")
  --write-baseline     Score every tracked, in-scope source file in the project
                        and (re)write the baseline at --baseline. This is the
                        one-way ratchet seed; run it on a known-good commit.
  --html               Render an HTML report next to the baseline. With
                        --write-baseline: the whole-project baseline report
                        (jev.baseline.html). On a gate run: a change report
                        (jev.baseline.change.html) — the committed baseline as a
                        grey backdrop with this run's changed files coloured. With
                        --dry-run: re-render the EXISTING baseline only (no Jev
                        calls, no API key).
  --repo-root <path>   Repo working tree to diff/read files from (default: cwd)
  --config <path>      Path to jev.gate.json (default: <repo-root>/jev.gate.json)
  --rubrics <path>     Path to rubrics.json (default: vendored copy next to this script)
  --baseline <path>    Path to jev.baseline.json (default: <repo-root>/<config.baselinePath>)
  --concurrency <n>    Parallel Jev calls (default: config.defaultConcurrency, 8)
  --mode <m>           "advisory" (report only, always exit 0) or "enforcing"
                        (exit 1 on a failing verdict). Default: config.mode,
                        overridable by $JEV_GATE_MODE.
  --json               Emit machine-readable JSON to stdout (default: human report)
  --dry-run            Resolve files/roles but skip Jev calls (no API key needed).
                        With --write-baseline, lists what would be scored and
                        writes nothing.
  --signoff <p::cat>   Acknowledge a low-confidence FAIL as human-reviewed (repeatable);
                        also read from $JEV_GATE_SIGNOFF (comma-separated)
  --help, -h            Show this help

Exit codes: 0 = gate passed (or baseline written), 1 = gate failed, 2 = usage/setup error.
`;

function readSignoffs(cli: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const s of cli) if (s) set.add(s);
  const fromEnv = process.env['JEV_GATE_SIGNOFF'];
  if (fromEnv) {
    for (const s of fromEnv.split(',').map((x) => x.trim()).filter(Boolean)) set.add(s);
  }
  return set;
}

/** True for the current `{ meta, files }` wrapper; legacy baselines are a bare map, without a `files` object. */
function isBaselineFile(data: unknown): data is BaselineFile {
  return typeof data === 'object' && data !== null && 'files' in data && typeof (data as BaselineFile).files === 'object';
}

function loadBaseline(path: string): { baseline: Baseline | null; meta: BaselineMeta | null; exists: boolean } {
  if (!existsSync(path)) return { baseline: null, meta: null, exists: false };
  const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (isBaselineFile(data)) return { baseline: data.files, meta: data.meta ?? null, exists: true };
  return { baseline: data as Baseline, meta: null, exists: true };
}

function chunkText(text: string, chunkChars: number): string[] {
  if (text.length <= chunkChars) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkChars) chunks.push(text.slice(i, i + chunkChars));
  return chunks;
}

interface Subject {
  relPath: string;
  roleName: string;
  roleHint: string | undefined;
  exempt: ReadonlySet<CategoryId>;
  content: string;
}

/** Resolve the changed, in-scope, non-skipped subjects; report role-skips/size-skips as FileResults directly. */
export function resolveSubjects(
  paths: readonly string[],
  config: GateConfig,
  repoRoot: string,
): { subjects: Subject[]; skipped: FileResult[] } {
  const subjects: Subject[] = [];
  const skipped: FileResult[] = [];

  for (const relPath of paths) {
    if (!isSourceFile(relPath, config.sourceExtensions) || isInSkipDir(relPath, config.skipDirs)) continue;

    const role = classifyRole(relPath, config);
    if (role.skip) {
      skipped.push({
        path: relPath,
        role: role.roleName,
        verdict: 'SKIPPED',
        skipReason: `role "${role.roleName}" is skipped entirely (${role.hint ?? 'no runtime behaviour to score'})`,
        reasons: [],
        advisories: [],
        hasBaseline: false,
      });
      continue;
    }
    if (role.exempt.size === ALL_CATEGORIES.length) {
      skipped.push({
        path: relPath,
        role: role.roleName,
        verdict: 'SKIPPED',
        skipReason: `role "${role.roleName}" exempts every category: nothing to ask Jev`,
        reasons: [],
        advisories: [],
        hasBaseline: false,
      });
      continue;
    }

    const absPath = join(repoRoot, relPath);
    let size: number;
    try {
      size = statSync(absPath).size;
    } catch (err) {
      skipped.push({
        path: relPath,
        role: role.roleName,
        verdict: 'ERROR',
        error: `cannot stat file: ${(err as Error).message}`,
        reasons: [],
        advisories: [],
        hasBaseline: false,
      });
      continue;
    }
    if (size > config.maxFileBytes) {
      skipped.push({
        path: relPath,
        role: role.roleName,
        verdict: 'TOO_BIG',
        skipReason: `larger than ${config.maxFileBytes} bytes`,
        reasons: [],
        advisories: [],
        hasBaseline: false,
      });
      continue;
    }

    const content = readFileSync(absPath, 'utf8');
    if (content.trim().length === 0) {
      skipped.push({
        path: relPath,
        role: role.roleName,
        verdict: 'SKIPPED',
        skipReason: 'empty file',
        reasons: [],
        advisories: [],
        hasBaseline: false,
      });
      continue;
    }

    subjects.push({ relPath, roleName: role.roleName, roleHint: role.hint, exempt: role.exempt, content });
  }

  return { subjects, skipped };
}

export async function scoreSubject(
  subject: Subject,
  ctx: { config: GateConfig; rubrics: ReturnType<typeof loadRubrics>; mergeBaseSha: string; repoRoot: string; jevCfg: ReturnType<typeof resolveProviderConfig>; baseline: Baseline | null; signoffs: ReadonlySet<string>; dryRun: boolean },
): Promise<FileResult> {
  const { config, rubrics, mergeBaseSha, repoRoot, jevCfg, baseline, signoffs, dryRun } = ctx;
  const diff = fileDiff(mergeBaseSha, subject.relPath, repoRoot, config.diffCharBudget);
  const baselineEntry = baseline?.[subject.relPath];

  const roleForEval = { roleName: subject.roleName, skip: false, exempt: subject.exempt, hint: subject.roleHint };

  if (dryRun) {
    return {
      path: subject.relPath,
      role: subject.roleName,
      ...(subject.roleHint !== undefined ? { roleHint: subject.roleHint } : {}),
      verdict: 'SKIPPED',
      skipReason: 'dry-run: role/diff resolved, no Jev call made',
      reasons: [],
      advisories: [],
      hasBaseline: baselineEntry !== undefined,
    };
  }

  const chunks = chunkText(subject.content, config.chunkChars);
  const state: JevState = {
    path: subject.relPath,
    content: chunks.length === 1 ? (chunks[0] ?? '') : chunks.map((c, i) => ({ part: i + 1, of: chunks.length, content: c })),
    diff: diff.text,
  };
  if (subject.roleHint) state.role_hint = subject.roleHint;

  let answers: Record<string, { score: number; confidence: number }>;
  try {
    const result = await callJev(jevCfg, state, toJevQuestions(rubrics, subject.exempt));
    answers = result.answers;
  } catch (err) {
    if (err instanceof JevFileTooBigError) {
      return {
        path: subject.relPath,
        role: subject.roleName,
        ...(subject.roleHint !== undefined ? { roleHint: subject.roleHint } : {}),
        verdict: 'TOO_BIG',
        skipReason: err.message,
        reasons: [],
        advisories: [],
        hasBaseline: baselineEntry !== undefined,
      };
    }
    return {
      path: subject.relPath,
      role: subject.roleName,
      ...(subject.roleHint !== undefined ? { roleHint: subject.roleHint } : {}),
      verdict: 'ERROR',
      error: (err as Error).message,
      reasons: [`Jev call failed: ${(err as Error).message}`],
      advisories: [],
      hasBaseline: baselineEntry !== undefined,
    };
  }

  const categories: Partial<Record<CategoryId, CategoryResult>> = {};
  for (const cat of ALL_CATEGORIES) {
    if (subject.exempt.has(cat)) continue;
    const agg = aggregateCategory(rubrics[cat], cat, answers);
    const evaluated = evaluateCategory({
      path: subject.relPath,
      category: cat,
      answer: agg.answer,
      role: roleForEval,
      config,
      baseline: baselineEntry,
      signoffs,
    });
    categories[cat] = { ...evaluated, subs: agg.subs, ...(agg.decidedBy !== undefined ? { decidedBy: agg.decidedBy } : {}) };
  }
  const scores: Partial<Record<CategoryId, number>> = {};
  for (const cat of ALL_CATEGORIES) {
    const c = categories[cat];
    if (c) scores[cat] = c.score;
  }
  const overall = evaluateOverall(scores, config, baselineEntry);

  const reasons = blockingReasons(categories, overall, config);
  const warns = warnNotes(categories, overall, config);
  const advisories = advisoryNotes(categories, config);
  const verdict = verdictFromReasons(reasons, warns);

  return {
    path: subject.relPath,
    role: subject.roleName,
    ...(subject.roleHint !== undefined ? { roleHint: subject.roleHint } : {}),
    verdict,
    categories,
    overall,
    reasons,
    advisories,
    hasBaseline: baselineEntry !== undefined,
  };
}

/** Score one file for the baseline: absolute scores only (no diff, no ratchet, no signoff). */
export async function scoreForBaseline(
  subject: Subject,
  ctx: { config: GateConfig; rubrics: ReturnType<typeof loadRubrics>; jevCfg: ReturnType<typeof resolveProviderConfig> },
): Promise<{ path: string; entry: BaselineEntry; usage: JevUsage } | { path: string; error: string; tooBig: boolean }> {
  const { config, rubrics, jevCfg } = ctx;
  const chunks = chunkText(subject.content, config.chunkChars);
  const state: JevState = {
    path: subject.relPath,
    content: chunks.length === 1 ? (chunks[0] ?? '') : chunks.map((c, i) => ({ part: i + 1, of: chunks.length, content: c })),
    diff: '',
  };
  if (subject.roleHint) state.role_hint = subject.roleHint;

  let answers: Record<string, { score: number; confidence: number }>;
  let usage: JevUsage;
  try {
    ({ answers, usage } = await callJev(jevCfg, state, toJevQuestions(rubrics, subject.exempt)));
  } catch (err) {
    return { path: subject.relPath, error: (err as Error).message, tooBig: err instanceof JevFileTooBigError };
  }

  const categories: Partial<Record<CategoryId, number>> = {};
  const confidences: Partial<Record<CategoryId, number>> = {};
  const subs: Partial<Record<CategoryId, SubAnswers>> = {};
  const decidedBy: Partial<Record<CategoryId, string>> = {};
  for (const cat of ALL_CATEGORIES) {
    if (subject.exempt.has(cat)) continue;
    const agg = aggregateCategory(rubrics[cat], cat, answers);
    categories[cat] = agg.answer.score;
    confidences[cat] = agg.answer.confidence;
    subs[cat] = agg.subs;
    if (agg.decidedBy !== undefined) decidedBy[cat] = agg.decidedBy;
  }
  // Persisted overall is the raw-score mean of the categories asked, matching the live gate (evaluateOverall).
  const askedScores = Object.values(categories);
  const overall = askedScores.length ? askedScores.reduce((sum, s) => sum + s, 0) / askedScores.length : 0;
  return { path: subject.relPath, entry: { categories, confidences, overall, subs, decidedBy }, usage };
}

/** Sibling `.html` path for a baseline JSON file (foo.json -> foo.html, else foo + .html). */
function htmlPathFor(baselinePath: string): string {
  return baselinePath.endsWith('.json') ? `${baselinePath.slice(0, -'.json'.length)}.html` : `${baselinePath}.html`;
}

function writeBaselineHtml(
  baseline: Baseline,
  meta: BaselineMeta | null,
  baselinePath: string,
  repoRoot: string,
  focus: readonly string[] | null,
  confidenceFloor: number,
): string {
  const htmlPath = htmlPathFor(baselinePath);
  writeFileSync(htmlPath, renderBaselineHtml(baseline, meta, focus, confidenceFloor));
  process.stderr.write(`jev-gate: baseline HTML written to ${relative(repoRoot, htmlPath)}\n`);
  return htmlPath;
}

/** Sibling `.change.html` path for a gate run's change report. */
function changeHtmlPathFor(baselinePath: string): string {
  return baselinePath.endsWith('.json') ? `${baselinePath.slice(0, -'.json'.length)}.change.html` : `${baselinePath}.change.html`;
}

/** A scored changed file as a baseline entry (raw scores + confidences), for the change report's coloured overlay. */
function changedEntry(file: FileResult): BaselineEntry | null {
  if (!file.categories || !file.overall) return null;
  const categories: Partial<Record<CategoryId, number>> = {};
  const confidences: Partial<Record<CategoryId, number>> = {};
  const subs: Partial<Record<CategoryId, SubAnswers>> = {};
  const decidedBy: Partial<Record<CategoryId, string>> = {};
  for (const cat of ALL_CATEGORIES) {
    const cr = file.categories[cat];
    if (!cr) continue;
    categories[cat] = cr.score;
    confidences[cat] = cr.confidence;
    if (cr.subs) subs[cat] = cr.subs;
    if (cr.decidedBy !== undefined) decidedBy[cat] = cr.decidedBy;
  }
  return { categories, confidences, overall: file.overall.mean, subs, decidedBy };
}

/** `--html` without `--write-baseline`: render the existing baseline file to HTML, no scoring. */
function renderBaselineOnly(opts: CliOptions): number {
  const config = loadGateConfig(opts.configPath);
  const baselinePath = opts.baselinePath ?? join(opts.repoRoot, config.baselinePath);
  const { baseline, meta, exists } = loadBaseline(baselinePath);
  if (!exists) {
    process.stderr.write(`jev-gate: no baseline at ${relative(opts.repoRoot, baselinePath)} — run --write-baseline first\n`);
    return 2;
  }
  writeBaselineHtml(baseline ?? {}, meta, baselinePath, opts.repoRoot, null, config.thresholds.confidence.blockingMin);
  return 0;
}

/** `--write-baseline`: score the whole tracked, in-scope project and write the ratchet seed. */
async function runBaseline(opts: CliOptions): Promise<number> {
  const config = loadGateConfig(opts.configPath);
  const rubrics = loadRubrics(opts.rubricsPath);
  const baselinePath = opts.baselinePath ?? join(opts.repoRoot, config.baselinePath);

  const tracked = trackedFiles(opts.repoRoot);
  const { subjects, skipped } = resolveSubjects(tracked, config, opts.repoRoot);
  const preemptiveTooBig = skipped.filter((f) => f.verdict === 'TOO_BIG');
  process.stderr.write(
    `jev-gate: baseline — ${tracked.length} tracked file(s), ${subjects.length} to score, ${skipped.length} skipped by role/size\n`,
  );

  if (opts.dryRun) {
    for (const s of subjects) process.stderr.write(`jev-gate: would score ${s.relPath} (role ${s.roleName})\n`);
    process.stderr.write(`jev-gate: dry-run — ${subjects.length} file(s) would be scored, nothing written\n`);
    return 0;
  }

  const jevCfg = resolveProviderConfig();
  if (!jevCfg.key) {
    process.stderr.write(`jev-gate: set ${jevCfg.keyEnvVar} (or pass --dry-run)\n`);
    return 2;
  }

  const concurrency = opts.concurrency ?? config.defaultConcurrency;
  let done = 0;
  let errored = 0;
  let tooBig = preemptiveTooBig.length;
  const tooBigPaths: string[] = preemptiveTooBig.map((f) => f.path);
  const entries: { path: string; entry: BaselineEntry }[] = [];
  let apiCalls = 0;
  let totalCostUsd = 0;
  let costReported = false;
  let totalInputTokens = 0;
  let tokensReported = false;
  const startedAt = Date.now();
  await runPool(subjects, concurrency, async (subject) => {
    const r = await scoreForBaseline(subject, { config, rubrics, jevCfg });
    done += 1;
    if ('error' in r) {
      if (r.tooBig) {
        tooBig += 1;
        tooBigPaths.push(r.path);
        process.stderr.write(`jev-gate: ${done}/${subjects.length} TOO BIG ${r.path}: ${r.error}\n`);
      } else {
        errored += 1;
        process.stderr.write(`jev-gate: ${done}/${subjects.length} ERROR ${r.path}: ${r.error}\n`);
      }
    } else {
      entries.push({ path: r.path, entry: r.entry });
      apiCalls += 1;
      if (typeof r.usage.cost === 'number') {
        totalCostUsd += r.usage.cost;
        costReported = true;
      }
      if (typeof r.usage.input_tokens === 'number') {
        totalInputTokens += r.usage.input_tokens;
        tokensReported = true;
      }
      process.stderr.write(`jev-gate: ${done}/${subjects.length} scored ${r.path} (${Math.round((r.entry.overall / 4) * 100)}/100)\n`);
    }
    return r;
  });
  const durationMs = Date.now() - startedAt;

  entries.sort((a, b) => a.path.localeCompare(b.path));
  const baseline: Baseline = {};
  for (const { path, entry } of entries) baseline[path] = entry;
  const meta: BaselineMeta = {
    generatedAt: new Date().toISOString(),
    model: jevCfg.model,
    provider: jevCfg.provider,
    concurrency,
    durationMs,
    apiCalls,
    filesScored: entries.length,
    totalCostUsd: costReported ? totalCostUsd : null,
    totalInputTokens: tokensReported ? totalInputTokens : null,
  };
  const baselineFile: BaselineFile = { meta, files: baseline };
  writeFileSync(baselinePath, `${JSON.stringify(baselineFile, null, 2)}\n`);
  const tooBigSuffix = tooBig > 0 ? ` (too big: ${[...tooBigPaths].sort().join(', ')})` : '';
  process.stderr.write(
    `jev-gate: baseline written to ${relative(opts.repoRoot, baselinePath)} — ${entries.length} file(s) scored, ${tooBig} too big${tooBigSuffix}, ${errored} errored\n`,
  );
  if (opts.html) writeBaselineHtml(baseline, meta, baselinePath, opts.repoRoot, null, config.thresholds.confidence.blockingMin);
  return errored > 0 ? 1 : 0;
}

export function renderHuman(result: GateResult): string {
  const lines: string[] = [];
  lines.push(`Jev CI gate [${result.summary.mode}] — base ${result.summary.base} (merge-base ${result.summary.mergeBase.slice(0, 12)})`);
  lines.push(`model ${result.model} via ${result.provider}`);
  lines.push('');
  const order: FileResult['verdict'][] = ['FAIL', 'ERROR', 'WARN', 'TOO_BIG', 'SKIPPED', 'PASS'];
  for (const wantVerdict of order) {
    const files = result.files.filter((f) => f.verdict === wantVerdict);
    if (files.length === 0) continue;
    lines.push(`## ${wantVerdict} (${files.length})`);
    for (const f of files) {
      lines.push(`- ${f.path}${f.overall ? ` [${f.overall.mean100}/100]` : ''}`);
      for (const r of f.reasons) lines.push(`    reason: ${r}`);
      for (const a of f.advisories) lines.push(`    advisory: ${a}`);
      if (f.skipReason) lines.push(`    skipped: ${f.skipReason}`);
      if (f.error) lines.push(`    error: ${f.error}`);
    }
    lines.push('');
  }
  for (const note of result.summary.notes) lines.push(`note: ${note}`);
  lines.push('');
  lines.push(
    `GATE: ${result.summary.verdict} — ${result.summary.filesScored} scored, ${result.summary.filesSkipped} skipped, ${result.summary.filesTooBig} too big, ${result.summary.filesErrored} errored`,
  );
  return lines.join('\n');
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (opts.writeBaseline) {
    return runBaseline(opts);
  }

  if (opts.html && opts.dryRun) {
    return renderBaselineOnly(opts);
  }

  const config = loadGateConfig(opts.configPath);
  const rubrics = loadRubrics(opts.rubricsPath);
  const baselinePath = opts.baselinePath ?? join(opts.repoRoot, config.baselinePath);
  const signoffs = readSignoffs(opts.signoffs);

  const envMode = process.env['JEV_GATE_MODE'];
  if (envMode !== undefined && envMode !== 'advisory' && envMode !== 'enforcing') {
    process.stderr.write(`jev-gate: $JEV_GATE_MODE must be "advisory" or "enforcing", got "${envMode}"\n`);
    return 2;
  }
  const mode: GateMode = opts.mode ?? (envMode as GateMode | undefined) ?? config.mode;

  const baseRef = resolveBaseRef(opts.base, opts.repoRoot);
  const mergeBaseSha = mergeBase(baseRef, opts.repoRoot);
  const changed = changedFiles(mergeBaseSha, opts.repoRoot);

  const { subjects, skipped } = resolveSubjects(changed, config, opts.repoRoot);
  const { baseline, exists: baselineExists } = loadBaseline(baselinePath);

  const notes: string[] = [];
  if (!baselineExists) {
    notes.push(
      `baseline ${relative(opts.repoRoot, baselinePath)} not found — degrading to absolute new-file gating only ` +
        '(proposal §5: no ratchet/regression check is possible without a committed baseline)',
    );
  }

  process.stderr.write(`jev-gate: base=${baseRef} merge-base=${mergeBaseSha}\n`);
  process.stderr.write(`jev-gate: ${changed.length} changed file(s), ${subjects.length} to score, ${skipped.length} skipped by role/size\n`);

  const jevCfg = resolveProviderConfig();
  if (!opts.dryRun && !jevCfg.key) {
    process.stderr.write(`jev-gate: set ${jevCfg.keyEnvVar} (or pass --dry-run)\n`);
    return 2;
  }

  const concurrency = opts.concurrency ?? config.defaultConcurrency;
  let scoredCount = 0;
  const scored = await runPool(subjects, concurrency, async (subject) => {
    const r = await scoreSubject(subject, { config, rubrics, mergeBaseSha, repoRoot: opts.repoRoot, jevCfg, baseline, signoffs, dryRun: opts.dryRun });
    scoredCount += 1;
    process.stderr.write(`jev-gate: ${scoredCount}/${subjects.length} scored (${r.path}: ${r.verdict})\n`);
    return r;
  });

  const files = [...skipped, ...scored].sort((a, b) => a.path.localeCompare(b.path));
  const failingFiles = files.filter((f) => f.verdict === 'FAIL' || f.verdict === 'ERROR').map((f) => f.path);
  const needsSignoffFiles = files
    .filter((f) => f.categories && Object.values(f.categories).some((c) => c.verdict === 'NEEDS_SIGNOFF'))
    .map((f) => f.path);
  const warnFiles = files.filter((f) => f.verdict === 'WARN').map((f) => f.path);

  const summary: GateSummary = {
    mode,
    base: baseRef,
    mergeBase: mergeBaseSha,
    filesChanged: changed.length,
    filesScored: scored.filter((f) => f.verdict !== 'SKIPPED' && f.verdict !== 'ERROR' && f.verdict !== 'TOO_BIG').length,
    filesSkipped: files.filter((f) => f.verdict === 'SKIPPED').length,
    filesErrored: files.filter((f) => f.verdict === 'ERROR').length,
    filesTooBig: files.filter((f) => f.verdict === 'TOO_BIG').length,
    baselinePath: relative(opts.repoRoot, baselinePath),
    baselineExists,
    verdict: failingFiles.length > 0 ? 'FAIL' : 'PASS',
    failingFiles,
    needsSignoffFiles,
    warnFiles,
    notes,
  };

  const result: GateResult = {
    generatedAt: new Date().toISOString(),
    model: jevCfg.model,
    provider: jevCfg.provider,
    summary,
    files,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderHuman(result)}\n`);
  }

  if (opts.html) {
    // Change report: the whole committed baseline is the grey backdrop; the run's
    // scored changed files overlay it in colour (fresh scores win over baseline).
    const changedEntries: Baseline = {};
    for (const f of scored) {
      const entry = changedEntry(f);
      if (entry) changedEntries[f.path] = entry;
    }
    const background: Baseline = { ...(baseline ?? {}), ...changedEntries };
    const htmlPath = changeHtmlPathFor(baselinePath);
    writeFileSync(htmlPath, renderBaselineHtml(background, null, Object.keys(changedEntries), config.thresholds.confidence.blockingMin));
    process.stderr.write(`jev-gate: change report written to ${relative(opts.repoRoot, htmlPath)}\n`);
  }

  if (mode === 'advisory') {
    process.stderr.write(`jev-gate: GATE ${summary.verdict} — advisory mode, reporting only, exit 0\n`);
    return 0;
  }
  process.stderr.write(`jev-gate: GATE ${summary.verdict}\n`);
  return summary.verdict === 'PASS' ? 0 : 1;
}

const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMainModule) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      if (err instanceof GitError) {
        process.stderr.write(`jev-gate: ${err.message}\n`);
        process.exitCode = 2;
        return;
      }
      process.stderr.write(`jev-gate: fatal: ${(err as Error).stack ?? (err as Error).message}\n`);
      process.exitCode = 2;
    });
}
