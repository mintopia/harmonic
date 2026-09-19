import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { JEV_CATEGORIES, type JevCategory, type JevFileScore } from '../scripts/jev/types.js';
import {
  parseGateConfig,
  parseBaseline,
  classifyPath,
  classifyScore,
  judgeFile,
  excludedFileJudgement,
  erroredFileJudgement,
  tooBigFileJudgement,
  buildReport,
  decideExitCode,
  type GateConfig,
  type BaselineEntry,
  type FileJudgement,
} from '../scripts/jev/gate-policy.js';

const configPath = fileURLToPath(new URL('../jev.gate.json', import.meta.url));
const rawConfig: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

function baseConfig(overrides: Partial<GateConfig> = {}): GateConfig {
  return { ...(parseGateConfig(rawConfig) as GateConfig), ...overrides };
}

function score(overrides: Partial<Omit<JevFileScore, 'categories' | 'confidence'>> & {
  categories?: Partial<Record<JevCategory, number>>;
  confidence?: Partial<Record<JevCategory, number>>;
} = {}): JevFileScore {
  const { categories: categoryOverrides, confidence: confidenceOverrides, ...rest } = overrides;
  const categories = Object.fromEntries(JEV_CATEGORIES.map((c) => [c, 3])) as Record<JevCategory, number>;
  const confidence = Object.fromEntries(JEV_CATEGORIES.map((c) => [c, 0.9])) as Record<JevCategory, number>;
  return {
    path: 'src/thing.ts',
    categories: { ...categories, ...categoryOverrides },
    confidence: { ...confidence, ...confidenceOverrides },
    latencyMs: 100,
    costUsd: 0.01,
    inputTokens: 500,
    ...rest,
  };
}

describe('gateConfigSchema / parseGateConfig', () => {
  it('parses the committed jev.gate.json', () => {
    expect(() => parseGateConfig(rawConfig)).not.toThrow();
    const parsed = parseGateConfig(rawConfig);
    expect(parsed.mode).toBe('advisory');
    expect(parsed.gatedCategories).toEqual([
      'complexity_clean_code',
      'code_smells',
      'duplication',
      'testability',
      'error_handling',
    ]);
    expect(parsed.exemptions).toHaveLength(17);
  });

  it('rejects an unknown top-level key', () => {
    const bad = { ...(rawConfig as Record<string, unknown>), notARealKey: true };
    expect(() => parseGateConfig(bad)).toThrow(z.ZodError);
  });

  it('rejects an invalid category id in gatedCategories', () => {
    const bad = { ...(rawConfig as Record<string, unknown>), gatedCategories: ['not_a_real_category'] };
    expect(() => parseGateConfig(bad)).toThrow(z.ZodError);
  });

  it.each(['security', 'comments'] as const)('rejects "%s" in gatedCategories: never gatable', (category) => {
    const bad = { ...(rawConfig as Record<string, unknown>), gatedCategories: [category] };
    expect(() => parseGateConfig(bad)).toThrow(z.ZodError);
  });

  it('rejects an unknown key nested in a strict sub-object', () => {
    const bad = {
      ...(rawConfig as Record<string, unknown>),
      enforce: { newFileAbsolutes: true, modifiedFileAbsolutes: false, ratchet: false, extra: 1 },
    };
    expect(() => parseGateConfig(bad)).toThrow(z.ZodError);
  });
});

describe('parseBaseline', () => {
  it('is tolerant of the seed shape', () => {
    const seed = { note: 'seed file', generatedAt: null, commit: null, provider: null, model: null, files: {} };
    const baseline = parseBaseline(seed);
    expect(baseline).toEqual({ generatedAt: null, commit: null, provider: null, model: null, files: {} });
  });

  it('parses a populated baseline entry', () => {
    const raw = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      commit: 'abc123',
      provider: 'anthropic',
      model: 'claude',
      files: {
        'src/thing.ts': { categories: { testability: 3 }, confidence: { testability: 0.9 }, overall: 2.5 },
      },
    };
    const baseline = parseBaseline(raw);
    expect(baseline.files['src/thing.ts']).toEqual({
      categories: { testability: 3 },
      confidence: { testability: 0.9 },
      overall: 2.5,
    });
  });
});

describe('classifyScore: zone boundaries', () => {
  const zones = { failBelow: 1.5, passAtOrAbove: 2.5 };
  it.each([
    [1.49, 'fail'],
    [1.5, 'warn'],
    [2.49, 'warn'],
    [2.5, 'pass'],
    [0, 'fail'],
    [4, 'pass'],
  ] as const)('score %s -> %s', (input, zone) => {
    expect(classifyScore(input, 0.9, zones, 0.6).zone).toBe(zone);
  });
});

describe('warn never blocks in enforcing mode', () => {
  it('worst gated category exactly 2.0 -> verdict warn, blocking false', () => {
    const config = baseConfig({
      mode: 'enforcing',
      enforce: { newFileAbsolutes: true, modifiedFileAbsolutes: true, ratchet: true },
    });
    const judged = judgeFile({
      score: score({ categories: { complexity_clean_code: 2.0 } }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: undefined,
      config,
      mode: config.mode,
    });
    expect(judged.verdict).toBe('warn');
    expect(judged.blocking).toBe(false);
  });
});

describe('confidence downgrade', () => {
  const zones = { failBelow: 1.5, passAtOrAbove: 2.5 };

  it('score 1.2 conf 0.6 -> hard fail, downgraded false', () => {
    expect(classifyScore(1.2, 0.6, zones, 0.6)).toEqual({ zone: 'fail', downgraded: false });
  });

  it('score 1.2 conf 0.59 -> warn, downgraded true', () => {
    expect(classifyScore(1.2, 0.59, zones, 0.6)).toEqual({ zone: 'warn', downgraded: true });
  });

  it('downgraded fail sets needsHumanSignOff and does not block a new file with newFileAbsolutes true', () => {
    const config = baseConfig({
      mode: 'enforcing',
      enforce: { newFileAbsolutes: true, modifiedFileAbsolutes: false, ratchet: false },
    });
    const judged = judgeFile({
      score: score({ categories: { complexity_clean_code: 1.2 }, confidence: { complexity_clean_code: 0.59 } }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: undefined,
      config,
      mode: config.mode,
    });
    expect(judged.needsHumanSignOff).toBe(true);
    expect(judged.categories!.complexity_clean_code.downgraded).toBe(true);
    expect(judged.categories!.complexity_clean_code.zone).toBe('warn');
    expect(judged.blocking).toBe(false);
    expect(judged.verdict).toBe('warn');
  });

  it('confidence never upgrades a warn score', () => {
    expect(classifyScore(2.0, 0.99, zones, 0.6)).toEqual({ zone: 'warn', downgraded: false });
  });

  it('confidence never upgrades... nor does it touch a pass score', () => {
    expect(classifyScore(2.6, 0.1, zones, 0.6)).toEqual({ zone: 'pass', downgraded: false });
  });
});

describe('role exemptions', () => {
  const config = baseConfig();

  it.each([
    ['src/Button.stories.tsx', ['error_handling', 'testability', 'duplication']],
    ['src/foo.test.ts', ['testability', 'duplication', 'error_handling']],
    ['src/foo.spec.tsx', ['testability', 'duplication', 'error_handling']],
    ['src/__tests__/foo.ts', ['testability', 'duplication', 'error_handling']],
    ['src/__mocks__/foo.ts', ['testability', 'duplication', 'error_handling']],
    ['src/test/foo.ts', ['testability', 'duplication', 'error_handling']],
    ['src/tests/foo.ts', ['testability', 'duplication', 'error_handling']],
    ['src/fixtures/foo.ts', ['error_handling', 'testability', 'duplication']],
    ['src/foo.fixture.ts', ['error_handling', 'testability', 'duplication']],
    ['src/mocks/foo.ts', ['error_handling', 'testability', 'duplication']],
    ['src/migrations/0001_init.ts', ['duplication', 'testability']],
    ['src/0002_add_col.migration.ts', ['duplication', 'testability']],
  ] as const)('%s suppresses %j (not excluded)', (path, expected) => {
    const result = classifyPath(path, config);
    expect(result.excluded).toBe(false);
    expect(new Set(result.exemptCategories)).toEqual(new Set(expected));
  });

  it.each([
    'src/types.d.ts',
    'src/generated/foo.ts',
    'src/foo.gen.ts',
    'dist/index.js',
    'build/index.js',
    'node_modules/pkg/index.js',
  ])('%s is fully excluded', (path) => {
    const result = classifyPath(path, config);
    expect(result.excluded).toBe(true);
    expect(result.exemptCategories).toEqual([]);
  });

  it('a non-exempt file has empty exemptCategories', () => {
    const result = classifyPath('src/plain-file.ts', config);
    expect(result.excluded).toBe(false);
    expect(result.exemptCategories).toEqual([]);
    expect(result.matchedExemptions).toEqual([]);
  });

  it('overlapping globs union without duplicates', () => {
    const customConfig = baseConfig({
      exemptions: [
        { glob: '**/dup/**', suppress: ['testability', 'duplication'] },
        { glob: '**/*.ts', suppress: ['duplication', 'error_handling'] },
      ],
    });
    const result = classifyPath('src/dup/foo.ts', customConfig);
    expect(result.exemptCategories.sort()).toEqual(['duplication', 'error_handling', 'testability'].sort());
    expect(result.matchedExemptions).toEqual(['**/dup/**', '**/*.ts']);
  });
});

describe('advisory categories never block', () => {
  it.each(['security', 'comments'] as const)('%s hard-fail-shaped score never sets blocking', (category) => {
    const config = baseConfig({
      mode: 'enforcing',
      enforce: { newFileAbsolutes: true, modifiedFileAbsolutes: true, ratchet: true },
    });
    const judged = judgeFile({
      score: score({ categories: { [category]: 0.1 }, confidence: { [category]: 0.99 } }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: { categories: { [category]: 3.9 }, confidence: { [category]: 0.9 }, overall: null },
      config,
      mode: config.mode,
    });
    expect(judged.blocking).toBe(false);
    expect(judged.categories![category].gated).toBe(false);
    expect(judged.categories![category].advisory).toBe(true);
    expect(judged.categories![category].ratchetFail).toBe(false);
  });

  it('holds even for a hand-built GateConfig that bypasses parseGateConfig and smuggles "security" into gatedCategories', () => {
    const config = baseConfig({
      mode: 'enforcing',
      enforce: { newFileAbsolutes: true, modifiedFileAbsolutes: true, ratchet: true },
      gatedCategories: ['complexity_clean_code', 'code_smells', 'duplication', 'testability', 'error_handling', 'security'],
    });
    const judged = judgeFile({
      score: score({ categories: { security: 0.1 }, confidence: { security: 0.99 } }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: undefined,
      config,
      mode: config.mode,
    });
    expect(judged.categories!.security.gated).toBe(false);
    expect(judged.categories!.security.advisory).toBe(true);
    expect(judged.blocking).toBe(false);
    expect(judged.verdict).toBe('pass');
  });
});

describe('ratchet regressions', () => {
  const config = baseConfig();

  it('3.0 -> 2.5 trips (exact margin)', () => {
    const judged = judgeFile({
      score: score({ categories: { testability: 2.5 } }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: { categories: { testability: 3.0 }, confidence: {}, overall: null },
      config,
      mode: 'advisory',
    });
    expect(judged.categories!.testability.ratchetFail).toBe(true);
  });

  it('3.0 -> 2.51 does not trip', () => {
    const judged = judgeFile({
      score: score({ categories: { testability: 2.51 } }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: { categories: { testability: 3.0 }, confidence: {}, overall: null },
      config,
      mode: 'advisory',
    });
    expect(judged.categories!.testability.ratchetFail).toBe(false);
  });

  it('float epsilon case: 2.3 -> 1.8 trips despite the drop computing as 0.49999999999999978', () => {
    expect(2.3 - 1.8).not.toBe(0.5);
    const judged = judgeFile({
      score: score({ categories: { testability: 1.8 } }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: { categories: { testability: 2.3 }, confidence: {}, overall: null },
      config,
      mode: 'advisory',
    });
    expect(judged.categories!.testability.ratchetFail).toBe(true);
  });

  it('overall 3.0 -> 2.8 trips, 2.81 does not', () => {
    const tripped = judgeFile({
      score: score({ categories: Object.fromEntries(JEV_CATEGORIES.map((c) => [c, 2.8])) }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: { categories: {}, confidence: {}, overall: 3.0 },
      config,
      mode: 'advisory',
    });
    expect(tripped.overall!.ratchetFail).toBe(true);

    const notTripped = judgeFile({
      score: score({ categories: Object.fromEntries(JEV_CATEGORIES.map((c) => [c, 2.81])) }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: { categories: {}, confidence: {}, overall: 3.0 },
      config,
      mode: 'advisory',
    });
    expect(notTripped.overall!.ratchetFail).toBe(false);
  });

  it('improvement never regresses', () => {
    const judged = judgeFile({
      score: score({ categories: { testability: 3.5 } }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: { categories: { testability: 2.0 }, confidence: {}, overall: null },
      config,
      mode: 'advisory',
    });
    expect(judged.categories!.testability.ratchetFail).toBe(false);
  });

  it('a regression on an exempt category does not trip', () => {
    const judged = judgeFile({
      score: score({ categories: { testability: 1.0 } }),
      classification: classifyPath('src/foo.test.ts', config),
      baselineEntry: { categories: { testability: 3.0 }, confidence: {}, overall: null },
      config,
      mode: 'advisory',
    });
    expect(judged.categories!.testability.exempt).toBe(true);
    expect(judged.categories!.testability.ratchetFail).toBe(false);
  });

  it('a new file (no baseline entry) never produces ratchet findings', () => {
    const judged = judgeFile({
      score: score({ categories: { testability: 0.1 } }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: undefined,
      config,
      mode: 'advisory',
    });
    expect(JEV_CATEGORIES.every((c) => !judged.categories![c].ratchetFail)).toBe(true);
    expect(judged.overall!.ratchetFail).toBe(false);
    expect(judged.baselineStatus).toBe('new');
  });

  it('a baseline entry missing a category produces no finding for it', () => {
    const judged = judgeFile({
      score: score({ categories: { testability: 0.1 } }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: { categories: {}, confidence: {}, overall: null },
      config,
      mode: 'advisory',
    });
    expect(judged.categories!.testability.ratchetFail).toBe(false);
    expect(judged.categories!.testability.baseline).toBeNull();
  });

  it('skipWhenExempt: true reports overall but does not gate it for a partially-exempt file', () => {
    const judged = judgeFile({
      score: score(),
      classification: classifyPath('src/foo.test.ts', config),
      baselineEntry: undefined,
      config,
      mode: 'advisory',
    });
    expect(judged.overall).not.toBeNull();
    expect(judged.overall!.gated).toBe(false);
  });
});

describe('blocking decision across rollout phases', () => {
  const failScore = () => score({ categories: { complexity_clean_code: 1.0 }, confidence: { complexity_clean_code: 0.9 } });
  const regressBaseline: BaselineEntry = { categories: { complexity_clean_code: 3.0 }, confidence: {}, overall: null };

  it('advisory: never blocks, but verdict shows the true fail', () => {
    const config = baseConfig({ mode: 'advisory' });
    const newFile = judgeFile({
      score: failScore(),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: undefined,
      config,
      mode: 'advisory',
    });
    expect(newFile.blocking).toBe(false);
    expect(newFile.verdict).toBe('fail');
  });

  it('enforcing + newFileAbsolutes only: new file FAIL blocks, modified file FAIL/regression does not', () => {
    const config = baseConfig({
      mode: 'enforcing',
      enforce: { newFileAbsolutes: true, modifiedFileAbsolutes: false, ratchet: false },
    });
    const newFile = judgeFile({
      score: failScore(),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: undefined,
      config,
      mode: config.mode,
    });
    expect(newFile.blocking).toBe(true);

    const modifiedFile = judgeFile({
      score: failScore(),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: regressBaseline,
      config,
      mode: config.mode,
    });
    expect(modifiedFile.blocking).toBe(false);
    expect(modifiedFile.verdict).toBe('fail');
  });

  it('+ ratchet: modified file ratchet regression now blocks', () => {
    const config = baseConfig({
      mode: 'enforcing',
      enforce: { newFileAbsolutes: true, modifiedFileAbsolutes: false, ratchet: true },
    });
    const modifiedFile = judgeFile({
      score: score({ categories: { testability: 2.0 } }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: { categories: { testability: 3.0 }, confidence: {}, overall: null },
      config,
      mode: config.mode,
    });
    expect(modifiedFile.categories!.testability.ratchetFail).toBe(true);
    expect(modifiedFile.blocking).toBe(true);
  });

  it('+ modifiedFileAbsolutes: modified file absolute FAIL now blocks', () => {
    const config = baseConfig({
      mode: 'enforcing',
      enforce: { newFileAbsolutes: true, modifiedFileAbsolutes: true, ratchet: true },
    });
    const modifiedFile = judgeFile({
      score: failScore(),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: regressBaseline,
      config,
      mode: config.mode,
    });
    expect(modifiedFile.blocking).toBe(true);
  });
});

describe('decideExitCode', () => {
  it('skipped + onInfrastructureError skip -> 0', () => {
    expect(
      decideExitCode({ mode: 'enforcing', status: 'skipped', onInfrastructureError: 'skip', files: [] }),
    ).toBe(0);
  });

  it('skipped + onInfrastructureError fail -> 1', () => {
    expect(
      decideExitCode({ mode: 'enforcing', status: 'skipped', onInfrastructureError: 'fail', files: [] }),
    ).toBe(1);
  });

  it('advisory mode -> 0 always, even with a blocking-shaped file', () => {
    const blockingFile: FileJudgement = excludedFileJudgement('src/x.ts', { excluded: true, exclusionReason: 'x', exemptCategories: [], matchedExemptions: [] }, undefined);
    blockingFile.blocking = true;
    expect(
      decideExitCode({ mode: 'advisory', status: 'pass', onInfrastructureError: 'fail', files: [blockingFile] }),
    ).toBe(0);
  });

  it('enforcing with a blocking file -> 1', () => {
    const blockingFile: FileJudgement = excludedFileJudgement('src/x.ts', { excluded: true, exclusionReason: 'x', exemptCategories: [], matchedExemptions: [] }, undefined);
    blockingFile.blocking = true;
    expect(
      decideExitCode({ mode: 'enforcing', status: 'pass', onInfrastructureError: 'skip', files: [blockingFile] }),
    ).toBe(1);
  });

  it('enforcing with no blocking file -> 0', () => {
    expect(
      decideExitCode({ mode: 'enforcing', status: 'pass', onInfrastructureError: 'skip', files: [] }),
    ).toBe(0);
  });
});

describe('reasons text matches the specified format', () => {
  const config = baseConfig();

  it('hard fail sentence', () => {
    const judged = judgeFile({
      score: score({ categories: { complexity_clean_code: 1.2 }, confidence: { complexity_clean_code: 0.82 } }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: undefined,
      config,
      mode: 'advisory',
    });
    expect(judged.reasons).toContain(
      'complexity_clean_code 1.20 below fail threshold 1.50 with confidence 0.82 >= 0.60 -> FAIL',
    );
  });

  it('downgrade sentence', () => {
    const judged = judgeFile({
      score: score({ categories: { error_handling: 1.4 }, confidence: { error_handling: 0.41 } }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: undefined,
      config,
      mode: 'advisory',
    });
    expect(judged.reasons).toContain(
      'error_handling 1.40 below fail threshold 1.50 but confidence 0.41 < 0.60 -> downgraded to WARN, needs human sign-off',
    );
  });

  it('ratchet sentence', () => {
    const judged = judgeFile({
      score: score({ categories: { testability: 2.4 } }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: { categories: { testability: 3.0 }, confidence: {}, overall: null },
      config,
      mode: 'advisory',
    });
    expect(judged.reasons).toContain(
      'testability regressed from baseline 3.00 to 2.40 (drop 0.60 >= margin 0.50) -> ratchet FAIL',
    );
  });

  it('overall fail sentence', () => {
    const judged = judgeFile({
      score: score({ categories: Object.fromEntries(JEV_CATEGORIES.map((c) => [c, 1.5])) }),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: undefined,
      config,
      mode: 'advisory',
    });
    expect(judged.overall!.zone).toBe('fail');
    expect(judged.reasons).toContain('overall 38/100 below fail threshold 50/100');
  });

  it('excluded file has empty reasons', () => {
    const classification = classifyPath('src/types.d.ts', config);
    const judged = excludedFileJudgement('src/types.d.ts', classification, undefined);
    expect(judged.reasons).toEqual([]);
  });

  it('a file with nothing wrong has empty reasons', () => {
    const judged = judgeFile({
      score: score(),
      classification: classifyPath('src/thing.ts', config),
      baselineEntry: undefined,
      config,
      mode: 'advisory',
    });
    expect(judged.reasons).toEqual([]);
    expect(judged.verdict).toBe('pass');
  });
});

describe('excludedFileJudgement / erroredFileJudgement', () => {
  const config = baseConfig();

  it('builds a status: excluded judgement with null overall/categories', () => {
    const classification = classifyPath('src/types.d.ts', config);
    const judged = excludedFileJudgement('src/types.d.ts', classification, undefined);
    expect(judged.status).toBe('excluded');
    expect(judged.overall).toBeNull();
    expect(judged.categories).toBeNull();
    expect(judged.exclusionReason).toBe('**/*.d.ts');
    expect(judged.blocking).toBe(false);
    expect(judged.verdict).toBe('pass');
  });

  it('builds a status: error judgement that never counts as a fail', () => {
    const judged = erroredFileJudgement('src/broken.ts', 'scorer timed out', undefined);
    expect(judged.status).toBe('error');
    expect(judged.error).toBe('scorer timed out');
    expect(judged.overall).toBeNull();
    expect(judged.categories).toBeNull();
    expect(judged.verdict).toBe('pass');
    expect(judged.blocking).toBe(false);
  });

  it('builds a status: too-big judgement that never counts as a fail', () => {
    const judged = tooBigFileJudgement('src/huge.ts', 'too big: larger than 400000 bytes', undefined);
    expect(judged.status).toBe('too-big');
    expect(judged.error).toBe('too big: larger than 400000 bytes');
    expect(judged.overall).toBeNull();
    expect(judged.categories).toBeNull();
    expect(judged.verdict).toBe('pass');
    expect(judged.blocking).toBe(false);
    expect(judged.baselineStatus).toBe('new');
  });

  it('a too-big judgement with a baseline entry reports baselineStatus modified', () => {
    const judged = tooBigFileJudgement('src/huge.ts', 'too big', { categories: {}, confidence: {}, overall: null });
    expect(judged.baselineStatus).toBe('modified');
  });
});

describe('buildReport shape', () => {
  const config = baseConfig({ mode: 'enforcing', enforce: { newFileAbsolutes: true, modifiedFileAbsolutes: true, ratchet: true } });

  function fixtureFiles(): FileJudgement[] {
    const passFile = judgeFile({
      score: score({ path: 'src/b-pass.ts' }),
      classification: classifyPath('src/b-pass.ts', config),
      baselineEntry: undefined,
      config,
      mode: config.mode,
    });
    const warnFile = judgeFile({
      score: score({ path: 'src/a-warn.ts', categories: { testability: 2.0 } }),
      classification: classifyPath('src/a-warn.ts', config),
      baselineEntry: undefined,
      config,
      mode: config.mode,
    });
    const failFile = judgeFile({
      score: score({ path: 'src/d-fail.ts', categories: { complexity_clean_code: 1.0 }, confidence: { complexity_clean_code: 0.9 } }),
      classification: classifyPath('src/d-fail.ts', config),
      baselineEntry: undefined,
      config,
      mode: config.mode,
    });
    const excludedFile = excludedFileJudgement('src/c-excluded.d.ts', classifyPath('src/c-excluded.d.ts', config), undefined);
    const erroredFile = erroredFileJudgement('src/e-errored.ts', 'boom', undefined);
    const tooBigFile = tooBigFileJudgement('src/f-toobig.ts', 'too big: larger than 400000 bytes', undefined);
    return [passFile, warnFile, failFile, excludedFile, erroredFile, tooBigFile];
  }

  it('produces the expected shape and counts', () => {
    const report = buildReport({
      config,
      configPath: 'jev.gate.json',
      mode: config.mode,
      baseline: { generatedAt: null, commit: null, provider: null, model: null, files: {} },
      baselinePath: 'jev.baseline.json',
      base: { requested: 'develop', resolvedRef: 'develop', mergeBase: 'abc' },
      scorerInfo: { provider: 'anthropic', model: 'claude' },
      files: fixtureFiles(),
      truncated: false,
      unscored: [],
      usage: { calls: 5, costUsd: 0.5, inputTokens: 1000, totalLatencyMs: 500 },
      status: 'fail',
      skippedReason: null,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(report.config.advisoryCategories.sort()).toEqual(['comments', 'security'].sort());
    expect(report.counts).toEqual({
      changed: 6,
      excluded: 1,
      scored: 3,
      errored: 1,
      tooBig: 1,
      pass: 1,
      warn: 1,
      fail: 1,
      blocking: 1,
      needsHumanSignOff: 0,
      ratchetRegressions: 0,
    });
    expect(report.files.map((f) => f.path)).toEqual([
      'src/a-warn.ts',
      'src/b-pass.ts',
      'src/c-excluded.d.ts',
      'src/d-fail.ts',
      'src/e-errored.ts',
      'src/f-toobig.ts',
    ]);
    for (const file of report.files) {
      if (!file.categories) continue;
      for (const category of JEV_CATEGORIES) {
        const value = file.categories[category].score;
        expect(value).toBe(Math.round(value * 100) / 100);
      }
    }
    expect(report.exitCode).toBe(1);
  });
});
