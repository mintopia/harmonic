import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JEV_CATEGORIES, type JevCategory, type JevFileScore, type JevScorer, type JevScoreRequest } from '../scripts/jev/types.js';
import { parseArgs, runGate, writeBaseline, type ParsedArgs, type RunGateDeps } from '../scripts/jev/gate-run.js';

const CONFIG_PATH = 'jev.gate.json';
const BASELINE_PATH = 'jev.baseline.json';

function makeConfig(overrides: Record<string, unknown> = {}) {
  const base = {
    mode: 'advisory',
    enforce: { newFileAbsolutes: true, modifiedFileAbsolutes: false, ratchet: false },
    gatedCategories: ['complexity_clean_code', 'code_smells', 'duplication', 'testability', 'error_handling'],
    categoryZones: { failBelow: 1.5, passAtOrAbove: 2.5 },
    overallZones: { failBelow: 2.0, passAtOrAbove: 2.4, skipWhenExempt: true },
    confidence: { hardFailMin: 0.6 },
    ratchetMargins: { categoryDrop: 0.5, overallDrop: 0.2 },
    exemptions: [] as Array<{ glob: string; suppress: 'all' | string[] }>,
    scan: {
      defaultBase: 'develop',
      sourceExtensions: ['.ts', '.tsx', '.js'],
      maxFiles: 100,
      maxFileBytes: 400_000,
      concurrency: 4,
    },
    onInfrastructureError: 'skip',
  };
  const enforce = { ...base.enforce, ...((overrides.enforce as object | undefined) ?? {}) };
  const scan = { ...base.scan, ...((overrides.scan as object | undefined) ?? {}) };
  return { ...base, ...overrides, enforce, scan };
}

function emptyBaselineJson() {
  return { generatedAt: null, commit: null, provider: null, model: null, files: {} };
}

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    positionals: [],
    diff: false,
    base: undefined,
    configPath: CONFIG_PATH,
    baselinePath: BASELINE_PATH,
    modeOverride: undefined,
    concurrency: undefined,
    out: undefined,
    writeBaseline: false,
    quiet: false,
    ...overrides,
  };
}

function makeScoreRecord(overrides: Partial<Record<JevCategory, number>> = {}, base = 3): Record<JevCategory, number> {
  return Object.fromEntries(JEV_CATEGORIES.map((c) => [c, overrides[c] ?? base])) as Record<JevCategory, number>;
}

function makeConfidenceRecord(value = 0.9): Record<JevCategory, number> {
  return Object.fromEntries(JEV_CATEGORIES.map((c) => [c, value])) as Record<JevCategory, number>;
}

function fakeScorer(
  opts: {
    available?: boolean;
    scoreFn?: (req: JevScoreRequest) => Promise<JevFileScore> | JevFileScore;
  } = {},
): JevScorer & { calls: JevScoreRequest[] } {
  const calls: JevScoreRequest[] = [];
  return {
    info: { provider: 'test-provider', model: 'test-model' },
    available: () => opts.available ?? true,
    calls,
    async score(req: JevScoreRequest): Promise<JevFileScore> {
      calls.push(req);
      if (opts.scoreFn) return opts.scoreFn(req);
      return {
        path: req.path,
        categories: makeScoreRecord(),
        confidence: makeConfidenceRecord(),
        latencyMs: 10,
        costUsd: 0.001,
        inputTokens: 100,
      };
    },
  };
}

function makeDeps(
  opts: {
    files?: Record<string, string>;
    scorer?: JevScorer;
    git?: (args: string[]) => string;
    env?: NodeJS.ProcessEnv;
  } = {},
): RunGateDeps & { files: Map<string, string> } {
  const files = new Map<string, string>(
    Object.entries({
      [CONFIG_PATH]: JSON.stringify(makeConfig()),
      [BASELINE_PATH]: JSON.stringify(emptyBaselineJson()),
      ...opts.files,
    }),
  );
  return {
    files,
    repoRoot: '/fake-repo',
    git:
      opts.git ??
      (() => {
        throw new Error('git not stubbed for this test');
      }),
    readTextFile: (p) => files.get(p),
    writeTextFile: (p, content) => void files.set(p, content),
    fileExists: (p) => files.has(p),
    scorer: opts.scorer ?? fakeScorer(),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    env: opts.env ?? {},
  };
}

describe('parseArgs', () => {
  it('throws when --diff is combined with positionals', () => {
    expect(() => parseArgs(['--diff', 'src/a.ts'])).toThrow(/combined/);
  });

  it('throws when neither --diff nor positionals nor --write-baseline are given', () => {
    expect(() => parseArgs([])).toThrow(/--diff|file list/);
  });

  it('throws on an unknown flag', () => {
    expect(() => parseArgs(['--bogus-flag'])).toThrow();
  });

  it('throws on a non-numeric --concurrency', () => {
    expect(() => parseArgs(['--diff', '--concurrency', 'abc'])).toThrow(/concurrency/);
  });

  it('throws on a non-positive --concurrency', () => {
    expect(() => parseArgs(['--diff', '--concurrency', '0'])).toThrow(/concurrency/);
  });

  it('accepts --write-baseline with a positional file list and no --diff', () => {
    const args = parseArgs(['--write-baseline', 'src/a.ts', 'src/b.ts']);
    expect(args.writeBaseline).toBe(true);
    expect(args.diff).toBe(false);
    expect(args.positionals).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('throws when --write-baseline has no file list', () => {
    expect(() => parseArgs(['--write-baseline'])).toThrow(/--write-baseline/);
  });

  it('rejects an invalid --mode value', () => {
    expect(() => parseArgs(['--diff', '--mode', 'bogus'])).toThrow(/--mode/);
  });

  it('captures --out (the CLI entrypoint, scripts/jev-gate.ts, is responsible for actually writing to it)', () => {
    const args = parseArgs(['--diff', '--out', '/tmp/jev-report.json']);
    expect(args.out).toBe('/tmp/jev-report.json');
  });

  it('parses a plain --diff invocation with defaults', () => {
    const args = parseArgs(['--diff']);
    expect(args.diff).toBe(true);
    expect(args.configPath).toBe('jev.gate.json');
    expect(args.baselinePath).toBe('jev.baseline.json');
  });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-jevgate-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  return dir;
}

function realFsDeps(repoDir: string, overrides: Partial<RunGateDeps> = {}): RunGateDeps {
  return {
    repoRoot: repoDir,
    git: (args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim(),
    readTextFile: (p) => {
      const full = join(repoDir, p);
      return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
    },
    writeTextFile: (p, content) => writeFileSync(join(repoDir, p), content),
    fileExists: (p) => existsSync(join(repoDir, p)),
    scorer: fakeScorer(),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    env: {},
    ...overrides,
  };
}

describe('runGate: real git diff resolution', () => {
  it('resolves exactly the expected changed .ts files: excludes deletions, includes new untracked files', async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, CONFIG_PATH), JSON.stringify(makeConfig()));
      writeFileSync(join(dir, BASELINE_PATH), JSON.stringify(emptyBaselineJson()));
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(dir, 'src', 'deleteme.ts'), 'export const gone = 1;\n');
      writeFileSync(join(dir, 'README.md'), '# hi\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'init');

      git(dir, 'checkout', '-b', 'feature');
      writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
      writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
      execFileSync('git', ['-C', dir, 'rm', 'src/deleteme.ts'], { encoding: 'utf8' });
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'feature work');
      writeFileSync(join(dir, 'src', 'c.ts'), 'export const c = 1;\n');

      const deps = realFsDeps(dir);
      const args = makeArgs({ diff: true, base: 'main' });
      const { report } = await runGate(args, deps);

      const paths = report.files.map((f) => f.path).sort();
      expect(paths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
      expect(report.base?.resolvedRef).toBe('main');
      expect(report.base?.mergeBase).toBeTruthy();
      expect(report.status).not.toBe('error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runGate: unresolvable base', () => {
  it('reports skipped and names the ref when neither <base> nor origin/<base> resolves', async () => {
    const deps = makeDeps({
      git: () => {
        throw new Error('unknown revision or path not in the working tree');
      },
    });
    const args = makeArgs({ diff: true, base: 'totally-not-a-ref' });
    const { report } = await runGate(args, deps);
    expect(report.status).toBe('skipped');
    expect(report.skippedReason).toContain('totally-not-a-ref');
    expect(report.base).toEqual({ requested: 'totally-not-a-ref', resolvedRef: null, mergeBase: null });
  });

  it('respects onInfrastructureError: fail for an unresolvable base in enforcing mode', async () => {
    const deps = makeDeps({
      files: { [CONFIG_PATH]: JSON.stringify(makeConfig({ onInfrastructureError: 'fail' })) },
      git: () => {
        throw new Error('unknown revision');
      },
    });
    const args = makeArgs({ diff: true, base: 'totally-not-a-ref', modeOverride: 'enforcing' });
    const { report } = await runGate(args, deps);
    expect(report.status).toBe('skipped');
    expect(report.exitCode).toBe(1);
  });

  it('degrades to a skipped report instead of throwing when git fails after ref resolution (a transient diff/ls-files hiccup)', async () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === 'diff') throw new Error('transient git hiccup unrelated to ref resolution');
        if (args[0] === 'rev-parse') return 'develop';
        if (args[0] === 'merge-base') return 'deadbeef';
        return '';
      },
    });
    const args = makeArgs({ diff: true, base: 'develop' });
    const { report } = await runGate(args, deps);
    expect(report.status).toBe('skipped');
    expect(report.exitCode).toBe(0);
    expect(report.skippedReason).toMatch(/git command failed/);
    expect(report.base).toEqual({ requested: 'develop', resolvedRef: 'develop', mergeBase: 'deadbeef' });
  });
});

describe('runGate: extension filter', () => {
  it('never scores a changed README.md', async () => {
    const scorer = fakeScorer();
    const deps = makeDeps({ files: { 'README.md': '# hi\n' }, scorer });
    const args = makeArgs({ positionals: ['README.md'] });
    const { report } = await runGate(args, deps);
    expect(scorer.calls).toHaveLength(0);
    expect(report.counts.changed).toBe(0);
  });
});

describe('runGate: config parse failure', () => {
  it('returns status error, exitCode 0, and does not throw on a missing config file', async () => {
    const deps = makeDeps();
    deps.files.delete(CONFIG_PATH);
    const args = makeArgs({ positionals: ['src/a.ts'] });
    const { report } = await runGate(args, deps);
    expect(report.status).toBe('error');
    expect(report.exitCode).toBe(0);
    expect(report.skippedReason).toContain(CONFIG_PATH);
  });

  it('returns status error on invalid config content', async () => {
    const deps = makeDeps({ files: { [CONFIG_PATH]: '{"mode": "not-a-real-mode"}' } });
    const args = makeArgs({ positionals: ['src/a.ts'] });
    const { report } = await runGate(args, deps);
    expect(report.status).toBe('error');
    expect(report.exitCode).toBe(0);
    expect(report.files).toEqual([]);
  });
});

describe('runGate: missing API key', () => {
  it('marks every subject file as errored mentioning OPENROUTER_API_KEY, run status skipped, never calls the scorer', async () => {
    const scorer = fakeScorer({ available: false });
    const deps = makeDeps({ files: { 'src/a.ts': 'export const a = 1;\n' }, scorer });
    const args = makeArgs({ positionals: ['src/a.ts'] });
    const { report } = await runGate(args, deps);
    expect(scorer.calls).toHaveLength(0);
    expect(report.status).toBe('skipped');
    expect(report.exitCode).toBe(0);
    expect(report.files).toHaveLength(1);
    expect(report.files[0]?.status).toBe('error');
    expect(report.files[0]?.error).toContain('OPENROUTER_API_KEY');
  });
});

describe('runGate: one scorer failure does not abort the run', () => {
  it('marks the failing file errored with the thrown message and still scores the rest', async () => {
    const scorer = fakeScorer({
      scoreFn: async (req) => {
        if (req.path === 'src/bad.ts') throw new Error('boom');
        return {
          path: req.path,
          categories: makeScoreRecord(),
          confidence: makeConfidenceRecord(),
          latencyMs: 5,
          costUsd: 0,
          inputTokens: 10,
        };
      },
    });
    const deps = makeDeps({
      files: { 'src/bad.ts': 'export const bad = 1;\n', 'src/good.ts': 'export const good = 1;\n' },
      scorer,
    });
    const args = makeArgs({ positionals: ['src/bad.ts', 'src/good.ts'] });
    const { report } = await runGate(args, deps);

    const bad = report.files.find((f) => f.path === 'src/bad.ts');
    const good = report.files.find((f) => f.path === 'src/good.ts');
    expect(bad?.status).toBe('error');
    expect(bad?.error).toBe('boom');
    expect(good?.status).toBe('scored');
    expect(good?.verdict).toBe('pass');
  });
});

describe('runGate: maxFiles truncation', () => {
  it('scores only maxFiles candidates and sorts the rest into unscored', async () => {
    const paths = ['src/e.ts', 'src/a.ts', 'src/c.ts', 'src/b.ts', 'src/d.ts'];
    const files: Record<string, string> = { [CONFIG_PATH]: JSON.stringify(makeConfig({ scan: { maxFiles: 2 } })) };
    for (const p of paths) files[p] = `export const x = "${p}";\n`;
    const scorer = fakeScorer();
    const deps = makeDeps({ files, scorer });
    const args = makeArgs({ positionals: paths });
    const { report } = await runGate(args, deps);

    expect(report.truncated).toBe(true);
    expect(report.unscored).toEqual(['src/b.ts', 'src/c.ts', 'src/d.ts']);
    expect(report.counts.scored).toBe(2);
    expect(scorer.calls.map((c) => c.path).sort()).toEqual(['src/a.ts', 'src/e.ts']);
  });
});

describe('runGate: bounded concurrency', () => {
  it('never exceeds the configured concurrency and all files eventually score', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const scorer: JevScorer = {
      info: { provider: 'test', model: 'test' },
      available: () => true,
      async score(req: JevScoreRequest): Promise<JevFileScore> {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 15));
        inFlight -= 1;
        return {
          path: req.path,
          categories: makeScoreRecord(),
          confidence: makeConfidenceRecord(),
          latencyMs: 15,
          costUsd: 0,
          inputTokens: 0,
        };
      },
    };
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    const files: Record<string, string> = {};
    for (const p of paths) files[p] = `content ${p}`;
    const deps = makeDeps({ files, scorer });
    const args = makeArgs({ positionals: paths, concurrency: 2 });
    const { report } = await runGate(args, deps);

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(report.counts.scored).toBe(5);
  });
});

describe('CLI --out (integration)', () => {
  it('writes the JSON report to the --out file, exits 0, and never touches the network with no API key', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'harmonic-jevgate-out-'));
    const outFile = join(outDir, 'report.json');
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    try {
      execFileSync('npx', ['tsx', 'scripts/jev-gate.ts', '--diff', '--base', 'HEAD', '--out', outFile, '--quiet'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, OPENROUTER_API_KEY: '' },
      });
      const written = JSON.parse(readFileSync(outFile, 'utf8')) as { schemaVersion: number; status: string; exitCode: number };
      expect(written.schemaVersion).toBe(1);
      expect(['skipped', 'pass', 'fail']).toContain(written.status);
      expect(written.exitCode).toBe(0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('writeBaseline', () => {
  it('merges into the existing baseline, sorts file keys, drops note, refreshes metadata, never gates', async () => {
    const existing = {
      note: 'seed note',
      generatedAt: null,
      commit: null,
      provider: null,
      model: null,
      files: {
        'src/zzz.ts': { categories: { code_smells: 2 }, confidence: { code_smells: 0.8 }, overall: 2 },
        'src/aaa-existing.ts': { categories: { code_smells: 3 }, confidence: { code_smells: 0.9 }, overall: 3 },
      },
    };
    const scorer = fakeScorer({
      scoreFn: async (req) => ({
        path: req.path,
        categories: makeScoreRecord({ code_smells: 1 }),
        confidence: makeConfidenceRecord(),
        latencyMs: 1,
        costUsd: 0,
        inputTokens: 1,
      }),
    });
    const deps = makeDeps({
      files: {
        [BASELINE_PATH]: JSON.stringify(existing),
        'src/mmm-new.ts': 'export const mmm = 1;\n',
      },
      scorer,
      git: (args) => (args[0] === 'rev-parse' ? 'abc1234' : ''),
    });
    const args = makeArgs({ writeBaseline: true, positionals: ['src/mmm-new.ts'] });

    const summary = await writeBaseline(args, deps);
    expect(summary).toContain('jev baseline');

    const written = JSON.parse(deps.files.get(BASELINE_PATH) ?? '{}');
    expect(written.note).toBeUndefined();
    expect(Object.keys(written.files)).toEqual(['src/aaa-existing.ts', 'src/mmm-new.ts', 'src/zzz.ts']);
    expect(written.files['src/aaa-existing.ts']).toEqual(existing.files['src/aaa-existing.ts']);
    expect(written.files['src/mmm-new.ts'].categories.code_smells).toBe(1);
    expect(written.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(written.commit).toBe('abc1234');
    expect(written.provider).toBe('test-provider');
    expect(written.model).toBe('test-model');
  });

  it('falls back to a default concurrency and never throws when the gate config cannot be loaded', async () => {
    const scorer = fakeScorer({
      scoreFn: async (req) => ({
        path: req.path,
        categories: makeScoreRecord({ code_smells: 2 }),
        confidence: makeConfidenceRecord(),
        latencyMs: 1,
        costUsd: 0,
        inputTokens: 1,
      }),
    });
    const files = new Map<string, string>(
      Object.entries({
        [BASELINE_PATH]: JSON.stringify(emptyBaselineJson()),
        'src/only.ts': 'export const only = 1;\n',
      }),
    );
    const deps: RunGateDeps = {
      repoRoot: '/fake-repo',
      git: () => '',
      readTextFile: (p) => {
        if (p === CONFIG_PATH) throw new Error('EACCES: permission denied');
        return files.get(p);
      },
      writeTextFile: (p, content) => void files.set(p, content),
      fileExists: (p) => files.has(p),
      scorer,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      env: {},
    };
    const args = makeArgs({ writeBaseline: true, positionals: ['src/only.ts'] });

    const summary = await writeBaseline(args, deps);
    expect(summary).toContain('config unavailable');
    expect(summary).toContain('default concurrency 4');
    expect(summary).toContain('scored 1 file');

    const written = JSON.parse(files.get(BASELINE_PATH) ?? '{}');
    expect(written.files['src/only.ts'].categories.code_smells).toBe(2);
  });
});

describe('runGate: end-to-end pass/warn/fail/exempt', () => {
  it('produces correct counts and a summary naming the failing file and category', async () => {
    const scorer = fakeScorer({
      scoreFn: async (req) => {
        const categories =
          req.path === 'src/warn.ts'
            ? makeScoreRecord({}, 2.0)
            : req.path === 'src/fail.ts'
              ? makeScoreRecord({ code_smells: 1.0 })
              : makeScoreRecord();
        return {
          path: req.path,
          categories,
          confidence: makeConfidenceRecord(0.9),
          latencyMs: 5,
          costUsd: 0.002,
          inputTokens: 50,
        };
      },
    });
    const config = makeConfig({ exemptions: [{ glob: '**/exempt.*', suppress: 'all' }] });
    const deps = makeDeps({
      files: {
        [CONFIG_PATH]: JSON.stringify(config),
        'src/pass.ts': 'export const p = 1;\n',
        'src/warn.ts': 'export const w = 1;\n',
        'src/fail.ts': 'export const f = 1;\n',
        'src/exempt.ts': 'export const e = 1;\n',
      },
      scorer,
    });
    const args = makeArgs({ positionals: ['src/warn.ts', 'src/fail.ts', 'src/pass.ts', 'src/exempt.ts'] });
    const { report, summary } = await runGate(args, deps);

    expect(report.counts.changed).toBe(4);
    expect(report.counts.excluded).toBe(1);
    expect(report.counts.scored).toBe(3);
    expect(report.counts.pass).toBe(1);
    expect(report.counts.warn).toBe(1);
    expect(report.counts.fail).toBe(1);
    expect(summary).toContain('src/fail.ts');
    expect(summary).toContain('code_smells');
  });
});

describe('runGate: run-level status vs per-file status', () => {
  it('is "skipped", not "fail", when every file is individually errored due to no API key', async () => {
    const scorer = fakeScorer({ available: false });
    const deps = makeDeps({
      files: { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' },
      scorer,
    });
    const args = makeArgs({ positionals: ['src/a.ts', 'src/b.ts'] });
    const { report } = await runGate(args, deps);

    expect(report.files.every((f) => f.status === 'error')).toBe(true);
    expect(report.status).toBe('skipped');
    expect(report.status).not.toBe('fail');
  });
});
