import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { parseArgs as nodeParseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  buildReport,
  classifyPath,
  erroredFileJudgement,
  excludedFileJudgement,
  judgeFile,
  parseBaseline,
  parseGateConfig,
  type Baseline,
  type BaselineEntry,
  type FileJudgement,
  type GateConfig,
  type GateReport,
} from './gate-policy.js';
import { JEV_CATEGORIES, type JevScorer } from './types.js';
import { createHttpJevScorer } from './jev-client.js';

export interface ParsedArgs {
  positionals: string[];
  diff: boolean;
  base: string | undefined;
  configPath: string;
  baselinePath: string;
  modeOverride: 'advisory' | 'enforcing' | undefined;
  concurrency: number | undefined;
  out: string | undefined;
  writeBaseline: boolean;
  quiet: boolean;
}

function runNodeParseArgs(argv: string[]) {
  return nodeParseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      diff: { type: 'boolean', default: false },
      base: { type: 'string' },
      config: { type: 'string' },
      baseline: { type: 'string' },
      mode: { type: 'string' },
      concurrency: { type: 'string' },
      out: { type: 'string' },
      'write-baseline': { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
    },
  });
}

export function parseArgs(argv: string[]): ParsedArgs {
  let parsed: ReturnType<typeof runNodeParseArgs>;
  try {
    parsed = runNodeParseArgs(argv);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;

  const diff = Boolean(values.diff);
  const writeBaseline = Boolean(values['write-baseline']);

  if (diff && positionals.length > 0) {
    throw new Error('--diff cannot be combined with an explicit file list');
  }
  if (!diff && positionals.length === 0 && !writeBaseline) {
    throw new Error('provide --diff, an explicit file list, or --write-baseline with a file list');
  }
  if (writeBaseline && positionals.length === 0) {
    throw new Error('--write-baseline requires an explicit file list of paths to score');
  }

  const modeValue = values.mode;
  if (modeValue !== undefined && modeValue !== 'advisory' && modeValue !== 'enforcing') {
    throw new Error(`invalid --mode "${modeValue}": expected "advisory" or "enforcing"`);
  }

  let concurrency: number | undefined;
  if (values.concurrency !== undefined) {
    const n = Number(values.concurrency);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`--concurrency must be a positive integer, got "${values.concurrency}"`);
    }
    concurrency = n;
  }

  return {
    positionals,
    diff,
    base: values.base,
    configPath: values.config ?? 'jev.gate.json',
    baselinePath: values.baseline ?? 'jev.baseline.json',
    modeOverride: modeValue as 'advisory' | 'enforcing' | undefined,
    concurrency,
    out: values.out,
    writeBaseline,
    quiet: Boolean(values.quiet),
  };
}

export interface RunGateDeps {
  /** cwd to resolve relative paths and to run git in — defaults to the repo root (two levels up from this file). */
  repoRoot: string;
  /** Run git and return trimmed stdout; throw on non-zero exit. */
  git: (args: string[]) => string;
  /** Reads a text file relative to repoRoot; returns undefined if it doesn't exist. */
  readTextFile: (relPath: string) => string | undefined;
  writeTextFile: (relPath: string, content: string) => void;
  fileExists: (relPath: string) => boolean;
  scorer: JevScorer;
  now: () => Date;
  env: NodeJS.ProcessEnv;
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function resolveRepoRelativePath(repoRoot: string, relPath: string): string {
  return resolve(repoRoot, relPath);
}

export function createRealDeps(overrides: Partial<RunGateDeps> = {}): RunGateDeps {
  const repoRoot = overrides.repoRoot ?? REPO_ROOT;
  const defaults: RunGateDeps = {
    repoRoot,
    git: (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim(),
    readTextFile: (relPath) => {
      const full = resolveRepoRelativePath(repoRoot, relPath);
      return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
    },
    writeTextFile: (relPath, content) => writeFileSync(resolveRepoRelativePath(repoRoot, relPath), content),
    fileExists: (relPath) => existsSync(resolveRepoRelativePath(repoRoot, relPath)),
    scorer: createHttpJevScorer(),
    now: () => new Date(),
    env: process.env,
  };
  return { ...defaults, ...overrides };
}

export interface RunGateResult {
  report: GateReport;
  summary: string;
}

const ZERO_USAGE = { calls: 0, costUsd: 0, inputTokens: 0, totalLatencyMs: 0 };

function emptyBaseline(): Baseline {
  return { generatedAt: null, commit: null, provider: null, model: null, files: {} };
}

async function runWithConcurrency(count: number, limit: number, worker: (index: number) => Promise<void>): Promise<void> {
  if (count === 0) return;
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, count));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < count) {
        const index = next++;
        await worker(index);
      }
    }),
  );
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 12) : 'n/a';
}

function hasScoredFailure(files: FileJudgement[]): boolean {
  return files.some((f) => f.status === 'scored' && f.verdict === 'fail');
}

function renderSummary(report: GateReport): string {
  const lines: string[] = [];
  const baseText = report.base
    ? `base ${report.base.requested} (merge-base ${shortSha(report.base.mergeBase)})`
    : 'base n/a (explicit file list)';
  lines.push(
    `jev gate: ${report.mode} | ${baseText} | ${report.counts.changed} changed, ${report.counts.excluded} excluded, ${report.counts.scored} scored`,
  );

  if (report.skippedReason) {
    lines.push(`  SKIP  (run) ${report.skippedReason}`);
  }

  for (const file of report.files) {
    if (file.status === 'excluded') {
      lines.push(`  SKIP  ${file.path}   excluded (${file.exclusionReason ?? 'exempt'})`);
      continue;
    }
    if (file.status === 'error') {
      lines.push(`  SKIP  ${file.path}   ${file.error ?? 'error'}`);
      continue;
    }
    const score100 = file.overall ? String(file.overall.score100) : '?';
    if (file.verdict === 'fail') {
      lines.push(`  FAIL  ${file.path}   ${score100}/100   ${file.reasons.join('; ')}`);
    } else if (file.verdict === 'warn') {
      lines.push(`  WARN  ${file.path}   ${score100}/100   ${file.reasons.join('; ') || 'needs review'}`);
    } else {
      lines.push(`  PASS  ${file.path}   ${score100}/100`);
    }
  }

  lines.push(
    `jev gate: ${report.counts.fail} FAIL, ${report.counts.warn} WARN, ${report.counts.needsHumanSignOff} needs human sign-off, ${report.counts.ratchetRegressions} ratchet regressions.`,
  );
  const modeText = report.mode === 'advisory' ? 'reporting only, not blocking' : 'blocking on failures';
  lines.push(`jev gate: ${report.mode.toUpperCase()} mode - ${modeText}. exit ${report.exitCode}`);

  return lines.join('\n');
}

export async function runGate(args: ParsedArgs, deps: RunGateDeps): Promise<RunGateResult> {
  let config: GateConfig;
  try {
    const raw = deps.readTextFile(args.configPath);
    if (raw === undefined) throw new Error(`config file not found: ${args.configPath}`);
    config = parseGateConfig(JSON.parse(raw));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const report: GateReport = {
      schemaVersion: 1,
      generatedAt: deps.now().toISOString(),
      mode: 'advisory',
      enforce: { newFileAbsolutes: false, modifiedFileAbsolutes: false, ratchet: false },
      status: 'error',
      exitCode: 0,
      skippedReason: `failed to load gate config ${args.configPath}: ${message}`,
      base: null,
      provider: null,
      model: null,
      config: { path: args.configPath, gatedCategories: [], advisoryCategories: [] },
      baseline: { path: args.baselinePath, entryCount: 0, generatedAt: null },
      counts: {
        changed: 0,
        excluded: 0,
        scored: 0,
        errored: 0,
        pass: 0,
        warn: 0,
        fail: 0,
        blocking: 0,
        needsHumanSignOff: 0,
        ratchetRegressions: 0,
      },
      truncated: false,
      unscored: [],
      usage: { ...ZERO_USAGE },
      files: [],
    };
    return { report, summary: renderSummary(report) };
  }

  const mode = args.modeOverride ?? config.mode;

  let baseline: Baseline;
  try {
    const raw = deps.readTextFile(args.baselinePath) ?? '{"files":{}}';
    baseline = parseBaseline(JSON.parse(raw));
  } catch {
    baseline = emptyBaseline();
  }

  let base: { requested: string; resolvedRef: string | null; mergeBase: string | null } | null = null;
  let changed: string[];

  if (args.diff) {
    const requested = args.base ?? deps.env.JEV_GATE_BASE ?? config.scan.defaultBase;
    let resolvedRef: string | null = null;
    try {
      deps.git(['rev-parse', '--verify', requested]);
      resolvedRef = requested;
    } catch {
      try {
        deps.git(['rev-parse', '--verify', `origin/${requested}`]);
        resolvedRef = `origin/${requested}`;
      } catch {
        resolvedRef = null;
      }
    }

    if (resolvedRef === null) {
      const report = buildReport({
        config,
        configPath: args.configPath,
        mode,
        baseline,
        baselinePath: args.baselinePath,
        base: { requested, resolvedRef: null, mergeBase: null },
        scorerInfo: deps.scorer.info,
        files: [],
        truncated: false,
        unscored: [],
        usage: { ...ZERO_USAGE },
        status: 'skipped',
        skippedReason: `base ref not resolvable: ${requested}`,
        now: deps.now,
      });
      return { report, summary: renderSummary(report) };
    }

    let mergeBase: string;
    try {
      mergeBase = deps.git(['merge-base', resolvedRef, 'HEAD']);
    } catch {
      mergeBase = resolvedRef;
    }

    let diffed: string[];
    let uncommittedNewFiles: string[];
    try {
      diffed = deps
        .git(['diff', '--name-only', '--diff-filter=d', mergeBase])
        .split('\n')
        .filter(Boolean);
      uncommittedNewFiles = deps
        .git(['ls-files', '--others', '--exclude-standard'])
        .split('\n')
        .filter(Boolean);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const report = buildReport({
        config,
        configPath: args.configPath,
        mode,
        baseline,
        baselinePath: args.baselinePath,
        base: { requested, resolvedRef, mergeBase },
        scorerInfo: deps.scorer.info,
        files: [],
        truncated: false,
        unscored: [],
        usage: { ...ZERO_USAGE },
        status: 'skipped',
        skippedReason: `git command failed while listing changed files: ${message}`,
        now: deps.now,
      });
      return { report, summary: renderSummary(report) };
    }
    changed = [...new Set([...diffed, ...uncommittedNewFiles])].sort();
    base = { requested, resolvedRef, mergeBase };
  } else {
    changed = args.positionals;
  }

  const candidates = changed.filter((p) => config.scan.sourceExtensions.includes(extname(p)) && deps.fileExists(p));

  const excludedPaths: string[] = [];
  const subjectPathsAll: string[] = [];
  for (const p of candidates) {
    const classification = classifyPath(p, config);
    if (classification.excluded) excludedPaths.push(p);
    else subjectPathsAll.push(p);
  }

  let truncated = false;
  let unscored: string[] = [];
  let subjectPaths = subjectPathsAll;
  if (subjectPathsAll.length > config.scan.maxFiles) {
    unscored = subjectPathsAll.slice(config.scan.maxFiles).sort();
    subjectPaths = subjectPathsAll.slice(0, config.scan.maxFiles);
    truncated = true;
  }

  const excludedJudgements = excludedPaths.map((p) => excludedFileJudgement(p, classifyPath(p, config), baseline.files[p]));

  if (!deps.scorer.available()) {
    const erroredSubjects = subjectPaths.map((p) =>
      erroredFileJudgement(p, 'skipped: no API key configured (OPENROUTER_API_KEY unset)', baseline.files[p]),
    );
    const report = buildReport({
      config,
      configPath: args.configPath,
      mode,
      baseline,
      baselinePath: args.baselinePath,
      base,
      scorerInfo: deps.scorer.info,
      files: [...excludedJudgements, ...erroredSubjects],
      truncated,
      unscored,
      usage: { ...ZERO_USAGE },
      status: 'skipped',
      skippedReason: 'no API key: OPENROUTER_API_KEY is unset (or TYPESAFE_API_KEY, depending on JEV_PROVIDER)',
      now: deps.now,
    });
    return { report, summary: renderSummary(report) };
  }

  const concurrency = args.concurrency ?? config.scan.concurrency;
  const usage = { ...ZERO_USAGE };
  const scoredJudgements: FileJudgement[] = new Array(subjectPaths.length);

  await runWithConcurrency(subjectPaths.length, concurrency, async (i) => {
    const p = subjectPaths[i]!;
    const baselineEntry = baseline.files[p];
    let text: string | undefined;
    try {
      text = deps.readTextFile(p);
    } catch (err) {
      scoredJudgements[i] = erroredFileJudgement(p, err instanceof Error ? err.message : String(err), baselineEntry);
      return;
    }
    if (text === undefined) {
      scoredJudgements[i] = erroredFileJudgement(p, 'file not found', baselineEntry);
      return;
    }
    if (Buffer.byteLength(text, 'utf8') > config.scan.maxFileBytes) {
      scoredJudgements[i] = erroredFileJudgement(p, `skipped: larger than ${config.scan.maxFileBytes} bytes`, baselineEntry);
      return;
    }
    if (text.trim() === '') {
      scoredJudgements[i] = erroredFileJudgement(p, 'skipped: empty', baselineEntry);
      return;
    }
    try {
      const score = await deps.scorer.score({ path: p, content: text });
      const classification = classifyPath(p, config);
      scoredJudgements[i] = judgeFile({ score, classification, baselineEntry, config, mode });
      usage.calls += 1;
      usage.costUsd += score.costUsd;
      usage.inputTokens += score.inputTokens;
      usage.totalLatencyMs += score.latencyMs;
    } catch (err) {
      scoredJudgements[i] = erroredFileJudgement(p, err instanceof Error ? err.message : String(err), baselineEntry);
    }
  });

  const files = [...excludedJudgements, ...scoredJudgements];
  const status: 'pass' | 'fail' = hasScoredFailure(files) ? 'fail' : 'pass';

  const report = buildReport({
    config,
    configPath: args.configPath,
    mode,
    baseline,
    baselinePath: args.baselinePath,
    base,
    scorerInfo: deps.scorer.info,
    files,
    truncated,
    unscored,
    usage,
    status,
    skippedReason: null,
    now: deps.now,
  });

  return { report, summary: renderSummary(report) };
}

const DEFAULT_SCAN_CONCURRENCY = 4;

export async function writeBaseline(args: ParsedArgs, deps: RunGateDeps): Promise<string> {
  let concurrencyFromConfig: number;
  let configFallbackNote: string | null = null;
  try {
    const rawConfig = deps.readTextFile(args.configPath);
    if (rawConfig === undefined) throw new Error(`config file not found: ${args.configPath}`);
    const config = parseGateConfig(JSON.parse(rawConfig));
    concurrencyFromConfig = config.scan.concurrency;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    concurrencyFromConfig = DEFAULT_SCAN_CONCURRENCY;
    configFallbackNote = `config unavailable (${message}), using default concurrency ${DEFAULT_SCAN_CONCURRENCY}`;
  }

  let existing: Baseline;
  try {
    const raw = deps.readTextFile(args.baselinePath) ?? '{"files":{}}';
    existing = parseBaseline(JSON.parse(raw));
  } catch {
    existing = emptyBaseline();
  }

  const paths = args.positionals;
  const concurrency = args.concurrency ?? concurrencyFromConfig;
  const newEntries: Record<string, BaselineEntry> = {};
  let scored = 0;
  let errored = 0;

  await runWithConcurrency(paths.length, concurrency, async (i) => {
    const p = paths[i]!;
    const text = deps.readTextFile(p);
    if (text === undefined || text.trim() === '') {
      errored += 1;
      return;
    }
    try {
      const result = await deps.scorer.score({ path: p, content: text });
      const overall = JEV_CATEGORIES.reduce((sum, c) => sum + result.categories[c], 0) / JEV_CATEGORIES.length;
      newEntries[p] = { categories: result.categories, confidence: result.confidence, overall };
      scored += 1;
    } catch {
      errored += 1;
    }
  });

  const merged: Record<string, BaselineEntry> = { ...existing.files, ...newEntries };
  const files: Record<string, BaselineEntry> = {};
  for (const key of Object.keys(merged).sort()) {
    files[key] = merged[key]!;
  }

  let commit: string | null = null;
  try {
    commit = deps.git(['rev-parse', 'HEAD']);
  } catch {
    commit = null;
  }

  const baseline: Baseline = {
    generatedAt: deps.now().toISOString(),
    commit,
    provider: deps.scorer.info.provider,
    model: deps.scorer.info.model,
    files,
  };

  deps.writeTextFile(args.baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);

  const prefix = configFallbackNote ? `jev baseline: ${configFallbackNote}; ` : 'jev baseline: ';
  return `${prefix}scored ${scored} file(s), ${errored} skipped/errored, ${Object.keys(files).length} total entries -> ${args.baselinePath}`;
}
