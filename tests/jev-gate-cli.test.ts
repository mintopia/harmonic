import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadRubrics } from '../scripts/jev-gate/config.js';
import { ALL_CATEGORIES, type CategoryId, type GateConfig } from '../scripts/jev-gate/types.js';

const { callJev } = vi.hoisted(() => ({ callJev: vi.fn() }));

vi.mock('../scripts/jev-gate/jev-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/jev-gate/jev-client.js')>();
  return { ...actual, callJev };
});

import { parseArgs, renderHuman, resolveSubjects, scoreForBaseline, scoreSubject } from '../scripts/jev-gate/cli.js';
import { JevFileTooBigError, resolveProviderConfig } from '../scripts/jev-gate/jev-client.js';
import type { FileResult, GateResult } from '../scripts/jev-gate/types.js';

function makeConfig(overrides: Partial<GateConfig> = {}): GateConfig {
  return {
    mode: 'enforcing',
    thresholds: {
      category: { fail: 1.5, warn: 2.5 },
      overall: { fail: 2.0, warn: 2.4 },
      confidence: { blockingMin: 0.6 },
      ratchet: { categoryDrop: 0.5, overallDrop: 0.2 },
    },
    gatingCategories: [...ALL_CATEGORIES],
    advisoryCategories: [],
    roles: [],
    sourceExtensions: ['.ts', '.tsx', '.js'],
    skipDirs: ['node_modules', 'dist'],
    baselinePath: 'jev.baseline.json',
    maxFileBytes: 400000,
    chunkChars: 40000,
    diffCharBudget: 20000,
    defaultConcurrency: 4,
    ...overrides,
  };
}

const rubrics = loadRubrics(join(process.cwd(), 'scripts/jev-gate/rubrics.json'));

function makeSubject(relPath = 'package.json') {
  return { relPath, roleName: 'production', roleHint: undefined, exempt: new Set<CategoryId>(), content: 'const x = 1;\n' };
}

describe('resolveSubjects', () => {
  it('reports an oversized file as TOO_BIG and leaves the normal file as a subject', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-gate-cli-'));
    writeFileSync(join(dir, 'big.ts'), 'x'.repeat(200));
    writeFileSync(join(dir, 'small.ts'), 'const x = 1;\n');
    const config = makeConfig({ maxFileBytes: 100 });

    const { subjects, skipped } = resolveSubjects(['big.ts', 'small.ts'], config, dir);

    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.path).toBe('big.ts');
    expect(skipped[0]?.verdict).toBe('TOO_BIG');
    expect(skipped[0]?.skipReason).toMatch(/100|bytes/);
    expect(subjects).toHaveLength(1);
    expect(subjects[0]?.relPath).toBe('small.ts');
  });
});

describe('scoreSubject', () => {
  it('maps JevFileTooBigError to a TOO_BIG verdict with skipReason set', async () => {
    callJev.mockReset();
    callJev.mockRejectedValueOnce(new JevFileTooBigError('jev-gate: Jev API rejected file as too big'));
    const config = makeConfig();
    const result = await scoreSubject(makeSubject(), {
      config,
      rubrics,
      mergeBaseSha: 'HEAD',
      repoRoot: process.cwd(),
      jevCfg: resolveProviderConfig(),
      baseline: null,
      signoffs: new Set(),
      dryRun: false,
    });

    expect(result.verdict).toBe('TOO_BIG');
    expect(result.skipReason).toBe('jev-gate: Jev API rejected file as too big');
    expect(result.error).toBeUndefined();
  });

  it('still maps a generic Error to an ERROR verdict with error set', async () => {
    callJev.mockReset();
    callJev.mockRejectedValueOnce(new Error('jev-gate: Jev API unreachable: boom'));
    const config = makeConfig();
    const result = await scoreSubject(makeSubject(), {
      config,
      rubrics,
      mergeBaseSha: 'HEAD',
      repoRoot: process.cwd(),
      jevCfg: resolveProviderConfig(),
      baseline: null,
      signoffs: new Set(),
      dryRun: false,
    });

    expect(result.verdict).toBe('ERROR');
    expect(result.error).toBe('jev-gate: Jev API unreachable: boom');
    expect(result.skipReason).toBeUndefined();
  });
});

describe('scoreForBaseline', () => {
  it('reports JevFileTooBigError as tooBig: true', async () => {
    callJev.mockReset();
    callJev.mockRejectedValueOnce(new JevFileTooBigError('jev-gate: too big'));
    const config = makeConfig();
    const subject = makeSubject();
    const result = await scoreForBaseline(subject, { config, rubrics, jevCfg: resolveProviderConfig() });

    expect(result).toEqual({ path: subject.relPath, error: 'jev-gate: too big', tooBig: true });
  });

  it('reports a generic Error as tooBig: false', async () => {
    callJev.mockReset();
    callJev.mockRejectedValueOnce(new Error('jev-gate: Jev API error 500: oops'));
    const config = makeConfig();
    const subject = makeSubject();
    const result = await scoreForBaseline(subject, { config, rubrics, jevCfg: resolveProviderConfig() });

    expect(result).toEqual({ path: subject.relPath, error: 'jev-gate: Jev API error 500: oops', tooBig: false });
  });
});

describe('sub-question aggregation', () => {
  const subIds = Object.keys(rubrics.security.questions);

  it('scoreForBaseline aggregates security to the min of its sub scores and stores subs', async () => {
    callJev.mockReset();
    const answers: Record<string, { score: number; confidence: number }> = {};
    subIds.forEach((id, i) => {
      answers[`security.${id}`] = { score: i === 0 ? 1 : 3, confidence: i === 0 ? 0.4 : 0.9 };
    });
    callJev.mockResolvedValueOnce({ answers, usage: {} });
    const config = makeConfig();
    const result = await scoreForBaseline(makeSubject(), { config, rubrics, jevCfg: resolveProviderConfig() });

    if ('error' in result) throw new Error(`expected success, got error: ${result.error}`);
    expect(result.entry.categories.security).toBe(1);
    expect(result.entry.confidences?.security).toBe(0.4);
    expect(result.entry.subs?.security).toEqual(
      Object.fromEntries(subIds.map((id, i) => [id, { score: i === 0 ? 1 : 3, confidence: i === 0 ? 0.4 : 0.9 }])),
    );
    expect(result.entry.decidedBy?.security).toBe(subIds[0]);
    expect(result.entry.decidedBy?.complexity_clean_code).toBeUndefined();
  });

  it('scoreSubject attaches subs and decidedBy to the category result', async () => {
    callJev.mockReset();
    const answers: Record<string, { score: number; confidence: number }> = {};
    subIds.forEach((id, i) => {
      answers[`security.${id}`] = { score: i === 0 ? 1 : 3, confidence: i === 0 ? 0.4 : 0.9 };
    });
    callJev.mockResolvedValueOnce({ answers, usage: {} });
    const config = makeConfig();
    const result = await scoreSubject(makeSubject(), {
      config,
      rubrics,
      mergeBaseSha: 'HEAD',
      repoRoot: process.cwd(),
      jevCfg: resolveProviderConfig(),
      baseline: null,
      signoffs: new Set(),
      dryRun: false,
    });

    const security = result.categories?.security;
    expect(security?.score).toBe(1);
    expect(security?.decidedBy).toBe(subIds[0]);
    expect(security?.subs?.[subIds[0] as string]).toEqual({ score: 1, confidence: 0.4 });
  });
});

describe('renderHuman', () => {
  it('surfaces a too-big file in its own section and counts it apart from scored/errored in the GATE line', () => {
    function makeFile(overrides: Partial<FileResult>): FileResult {
      return { path: 'x', role: 'production', verdict: 'PASS', reasons: [], advisories: [], hasBaseline: false, ...overrides };
    }
    const files: FileResult[] = [
      makeFile({ path: 'src/execution/runner.ts', verdict: 'TOO_BIG', skipReason: 'jev-gate: Jev API rejected file as too big (status 413): payload too large' }),
      makeFile({ path: 'src/ok.ts', verdict: 'PASS' }),
      makeFile({ path: 'src/broken.ts', verdict: 'ERROR', error: 'jev-gate: Jev API unreachable: boom' }),
    ];
    const result: GateResult = {
      generatedAt: new Date(0).toISOString(),
      model: 'typesafe/jev-1.13',
      provider: 'openrouter',
      files,
      summary: {
        mode: 'enforcing',
        base: 'develop',
        mergeBase: '0123456789abcdef',
        filesChanged: files.length,
        filesScored: files.filter((f) => f.verdict !== 'SKIPPED' && f.verdict !== 'ERROR' && f.verdict !== 'TOO_BIG').length,
        filesSkipped: 0,
        filesErrored: files.filter((f) => f.verdict === 'ERROR').length,
        filesTooBig: files.filter((f) => f.verdict === 'TOO_BIG').length,
        baselinePath: 'jev.baseline.json',
        baselineExists: true,
        verdict: 'PASS',
        failingFiles: [],
        needsSignoffFiles: [],
        warnFiles: [],
        notes: [],
      },
    };

    const output = renderHuman(result);

    expect(output).toContain('## TOO_BIG (1)');
    expect(output).toContain('src/execution/runner.ts');
    expect(output).toContain('skipped: jev-gate: Jev API rejected file as too big');
    expect(output).toContain('GATE: PASS — 1 scored, 0 skipped, 1 too big, 1 errored');
  });
});

describe('parseArgs html option', () => {
  it('writes HTML reports by default', () => {
    expect(parseArgs([]).html).toBe('default');
  });

  it('--no-html turns reports off', () => {
    expect(parseArgs(['--no-html']).html).toBe('off');
  });

  it('--html is an explicit request, which with --dry-run selects render-only', () => {
    const opts = parseArgs(['--html', '--dry-run']);
    expect(opts.html).toBe('requested');
    expect(opts.dryRun).toBe(true);
  });
});

describe('parseArgs --mode', () => {
  it('accepts the two-argv-token form', () => {
    expect(parseArgs(['--mode', 'enforcing']).mode).toBe('enforcing');
    expect(parseArgs(['--mode', 'advisory']).mode).toBe('advisory');
  });

  it('accepts a pre-joined single token, "--mode <value>"', () => {
    expect(parseArgs(['--mode enforcing']).mode).toBe('enforcing');
    expect(parseArgs(['--mode advisory', '--json']).mode).toBe('advisory');
  });

  it('accepts the "--mode=<value>" form', () => {
    expect(parseArgs(['--mode=enforcing']).mode).toBe('enforcing');
  });

  it('rejects an invalid value in every form with the same message', () => {
    expect(() => parseArgs(['--mode', 'bogus'])).toThrow('--mode must be "advisory" or "enforcing", got "bogus"');
    expect(() => parseArgs(['--mode bogus'])).toThrow('--mode must be "advisory" or "enforcing", got "bogus"');
    expect(() => parseArgs(['--mode=bogus'])).toThrow('--mode must be "advisory" or "enforcing", got "bogus"');
  });
});
