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

import { resolveSubjects, scoreForBaseline, scoreSubject } from '../scripts/jev-gate/cli.js';
import { JevFileTooBigError, resolveProviderConfig } from '../scripts/jev-gate/jev-client.js';

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
