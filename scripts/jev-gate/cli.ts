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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGateConfig, loadRubrics } from './config.js';
import { changedFiles, fileDiff, GitError, mergeBase, resolveBaseRef } from './git.js';
import { classifyRole, isInSkipDir, isSourceFile } from './glob.js';
import { callJev, resolveProviderConfig, runPool, type JevState } from './jev-client.js';
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
  type CategoryId,
  type CategoryResult,
  type FileResult,
  type GateConfig,
  type GateResult,
  type GateSummary,
} from './types.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

interface CliOptions {
  base: string | undefined;
  repoRoot: string;
  configPath: string;
  rubricsPath: string;
  baselinePath: string | undefined;
  concurrency: number | undefined;
  json: boolean;
  dryRun: boolean;
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
    json: false,
    dryRun: false,
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
      case '--json':
        opts.json = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
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
  tsx scripts/jev-gate/cli.ts [--base <ref>] [--json] [options]

Options:
  --base <ref>         Base ref to diff against (default: $JEV_GATE_BASE, else
                        "develop" / "origin/develop" / the current branch's
                        upstream — never "main"/"origin/main")
  --repo-root <path>   Repo working tree to diff/read files from (default: cwd)
  --config <path>      Path to jev.gate.json (default: <repo-root>/jev.gate.json)
  --rubrics <path>     Path to rubrics.json (default: vendored copy next to this script)
  --baseline <path>    Path to jev.baseline.json (default: <repo-root>/<config.baselinePath>)
  --concurrency <n>    Parallel Jev calls (default: config.defaultConcurrency, 8)
  --json               Emit machine-readable JSON to stdout (default: human report)
  --dry-run            Classify/role-map changed files but skip Jev calls (no API key needed)
  --signoff <p::cat>   Acknowledge a low-confidence FAIL as human-reviewed (repeatable);
                        also read from $JEV_GATE_SIGNOFF (comma-separated)
  --help, -h            Show this help

Exit codes: 0 = gate passed, 1 = gate failed, 2 = usage/setup error.
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

function loadBaseline(path: string): { baseline: Baseline | null; exists: boolean } {
  if (!existsSync(path)) return { baseline: null, exists: false };
  const data = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
  return { baseline: data, exists: true };
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
function resolveSubjects(
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
        verdict: 'SKIPPED',
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

async function scoreSubject(
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
    const result = await callJev(jevCfg, state, rubrics);
    answers = result.answers;
  } catch (err) {
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

  const categories = {} as Record<CategoryId, CategoryResult>;
  for (const cat of ALL_CATEGORIES) {
    categories[cat] = evaluateCategory({
      path: subject.relPath,
      category: cat,
      answer: answers[cat],
      role: roleForEval,
      config,
      baseline: baselineEntry,
      signoffs,
    });
  }
  const categoryScores = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, categories[c].score])) as Record<CategoryId, number>;
  const overall = evaluateOverall(categoryScores, config, baselineEntry);

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

function renderHuman(result: GateResult): string {
  const lines: string[] = [];
  lines.push(`Jev CI gate — base ${result.summary.base} (merge-base ${result.summary.mergeBase.slice(0, 12)})`);
  lines.push(`model ${result.model} via ${result.provider}`);
  lines.push('');
  const order: FileResult['verdict'][] = ['FAIL', 'ERROR', 'WARN', 'SKIPPED', 'PASS'];
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
  lines.push(`GATE: ${result.summary.verdict} — ${result.summary.filesScored} scored, ${result.summary.filesSkipped} skipped, ${result.summary.filesErrored} errored`);
  return lines.join('\n');
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const config = loadGateConfig(opts.configPath);
  const rubrics = loadRubrics(opts.rubricsPath);
  const baselinePath = opts.baselinePath ?? join(opts.repoRoot, config.baselinePath);
  const signoffs = readSignoffs(opts.signoffs);

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
    base: baseRef,
    mergeBase: mergeBaseSha,
    filesChanged: changed.length,
    filesScored: scored.filter((f) => f.verdict !== 'SKIPPED' && f.verdict !== 'ERROR').length,
    filesSkipped: files.filter((f) => f.verdict === 'SKIPPED').length,
    filesErrored: files.filter((f) => f.verdict === 'ERROR').length,
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
  process.stderr.write(`jev-gate: GATE ${summary.verdict}\n`);

  return summary.verdict === 'PASS' ? 0 : 1;
}

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
