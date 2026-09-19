import { describe, expect, it } from 'vitest';
import {
  advisoryNotes,
  blockingReasons,
  categoryZone,
  evaluateCategory,
  evaluateOverall,
  overallZone,
  signoffKey,
  verdictFromReasons,
  warnNotes,
} from '../scripts/jev-gate/thresholds.js';
import { ALL_CATEGORIES, type Baseline, type CategoryId, type CategoryResult, type GateConfig, type RoleMatch } from '../scripts/jev-gate/types.js';

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
    sourceExtensions: ['.ts'],
    skipDirs: ['node_modules'],
    baselinePath: 'jev.baseline.json',
    maxFileBytes: 400000,
    chunkChars: 40000,
    diffCharBudget: 20000,
    defaultConcurrency: 4,
    ...overrides,
  };
}

const noRole: RoleMatch = { roleName: 'production', skip: false, exempt: new Set(), hint: undefined };

function evalCat(
  category: CategoryId,
  score: number,
  confidence: number,
  opts: { config?: GateConfig; role?: RoleMatch; baseline?: Baseline[string]; signoffs?: Set<string> } = {},
): CategoryResult {
  return evaluateCategory({
    path: 'src/foo.ts',
    category,
    answer: { score, confidence },
    role: opts.role ?? noRole,
    config: opts.config ?? makeConfig(),
    baseline: opts.baseline,
    signoffs: opts.signoffs ?? new Set(),
  });
}

describe('categoryZone / overallZone', () => {
  it('places scores at the zone boundaries (fail < 1.5 <= warn < 2.5 <= pass)', () => {
    const t = makeConfig().thresholds.category;
    expect(categoryZone(1.49, t)).toBe('FAIL');
    expect(categoryZone(1.5, t)).toBe('WARN');
    expect(categoryZone(2.49, t)).toBe('WARN');
    expect(categoryZone(2.5, t)).toBe('PASS');
  });

  it('places overall means at the zone boundaries (fail < 2.0 <= warn < 2.4 <= pass)', () => {
    const t = makeConfig().thresholds.overall;
    expect(overallZone(1.99, t)).toBe('FAIL');
    expect(overallZone(2.0, t)).toBe('WARN');
    expect(overallZone(2.39, t)).toBe('WARN');
    expect(overallZone(2.4, t)).toBe('PASS');
  });
});

describe('evaluateCategory — gating axis', () => {
  it('a high-confidence FAIL blocks (weighting keeps a confident low score in FAIL)', () => {
    const r = evalCat('code_smells', 1.0, 0.9); // weighted 1.1 -> FAIL
    expect(r.weighted).toBeCloseTo(1.1, 5);
    expect(r.zone).toBe('FAIL');
    expect(r.gated).toBe(true);
    expect(r.verdict).toBe('FAIL');
  });

  it('a low-confidence low score that stays in FAIL after weighting needs sign-off', () => {
    const r = evalCat('code_smells', 0.0, 0.5); // weighted 1.0 -> FAIL, confidence < blockingMin
    expect(r.weighted).toBeCloseTo(1.0, 5);
    expect(r.zone).toBe('FAIL');
    expect(r.verdict).toBe('NEEDS_SIGNOFF');
  });

  it('a signed-off low-confidence FAIL is downgraded to WARN', () => {
    const r = evalCat('code_smells', 0.0, 0.5, { signoffs: new Set([signoffKey('src/foo.ts', 'code_smells')]) });
    expect(r.verdict).toBe('WARN');
    expect(r.signoffAcknowledged).toBe(true);
  });

  it('weighting softens a low-confidence FAIL out of the FAIL zone entirely', () => {
    const r = evalCat('code_smells', 1.0, 0.4); // weighted 1.6 -> WARN, so no sign-off needed
    expect(r.weighted).toBeCloseTo(1.6, 5);
    expect(r.zone).toBe('WARN');
    expect(r.verdict).toBe('WARN');
  });

  it('WARN and PASS zones map straight through', () => {
    expect(evalCat('code_smells', 2.0, 0.9).verdict).toBe('WARN');
    expect(evalCat('code_smells', 3.5, 0.9).verdict).toBe('PASS');
  });

  it('a missing answer scores 0/0 and weights to the neutral prior (WARN, non-blocking)', () => {
    const r = evaluateCategory({
      path: 'src/foo.ts',
      category: 'code_smells',
      answer: undefined,
      role: noRole,
      config: makeConfig(),
      baseline: undefined,
      signoffs: new Set(),
    });
    expect(r.score).toBe(0);
    expect(r.confidence).toBe(0);
    expect(r.weighted).toBe(2.0); // 0·0 + 2·1
    expect(r.zone).toBe('WARN');
    expect(r.verdict).toBe('WARN');
  });
});

describe('evaluateCategory — security & comments are gating (blocking) per policy', () => {
  it('security FAIL with confidence blocks (verdict FAIL)', () => {
    const r = evalCat('security', 1.0, 0.9);
    expect(r.gated).toBe(true);
    expect(r.verdict).toBe('FAIL');
  });

  it('comments FAIL with confidence blocks (verdict FAIL)', () => {
    const r = evalCat('comments', 1.0, 0.9);
    expect(r.gated).toBe(true);
    expect(r.verdict).toBe('FAIL');
  });
});

describe('evaluateCategory — non-gating & exemptions', () => {
  it('an advisory-only category never reaches FAIL, but keeps its true zone', () => {
    const config = makeConfig({ gatingCategories: ['code_smells'], advisoryCategories: ['security'] });
    const r = evalCat('security', 1.0, 0.9, { config });
    expect(r.zone).toBe('FAIL');
    expect(r.gated).toBe(false);
    expect(r.verdict).toBe('WARN');
  });

  it('a role-exempted gating category is not gated (FAIL zone => WARN verdict)', () => {
    const role: RoleMatch = { roleName: 'test', skip: false, exempt: new Set<CategoryId>(['duplication']), hint: undefined };
    const r = evalCat('duplication', 1.0, 0.9, { role });
    expect(r.gated).toBe(false);
    expect(r.verdict).toBe('WARN');
  });
});

describe('evaluateCategory — ratchet regression', () => {
  const baseline: Baseline[string] = { categories: { code_smells: 3.0, duplication: 3.0 }, overall: 3.0 };

  it('flags a drop >= categoryDrop on a gated axis (weighted current vs weighted baseline)', () => {
    // current weighted 2.4·0.9+2·0.1 = 2.36; baseline has no confidence so weighs to raw 3.0.
    const r = evalCat('code_smells', 2.4, 0.9, { baseline });
    expect(r.ratchetRegression).toEqual({ baseline: 3.0, drop: expect.closeTo(0.64, 5) });
  });

  it('does not flag a drop smaller than the margin', () => {
    const r = evalCat('code_smells', 2.6, 0.9, { baseline });
    expect(r.ratchetRegression).toBeUndefined();
  });

  it('does not ratchet a non-gated (exempt) axis', () => {
    const role: RoleMatch = { roleName: 'test', skip: false, exempt: new Set<CategoryId>(['code_smells']), hint: undefined };
    const r = evalCat('code_smells', 1.0, 0.9, { baseline, role });
    expect(r.ratchetRegression).toBeUndefined();
  });
});

describe('evaluateOverall', () => {
  const scores = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, 3.0])) as Record<CategoryId, number>;

  it('computes the mean, mean100 and zone', () => {
    const r = evaluateOverall(scores, makeConfig(), undefined);
    expect(r.mean).toBe(3.0);
    expect(r.mean100).toBe(75);
    expect(r.zone).toBe('PASS');
  });

  it('flags an overall ratchet regression past the margin', () => {
    const dropped = { ...scores, code_smells: 1.0 } as Record<CategoryId, number>;
    const r = evaluateOverall(dropped, makeConfig(), { categories: {}, overall: 3.0 });
    expect(r.ratchetRegression?.baseline).toBe(3.0);
  });
});

describe('reason / note builders', () => {
  const config = makeConfig();
  function cats(partial: Partial<Record<CategoryId, CategoryResult>>): Record<CategoryId, CategoryResult> {
    const base = Object.fromEntries(
      ALL_CATEGORIES.map((c) => [c, { score: 3.0, confidence: 0.9, weighted: 2.9, zone: 'PASS', gated: true, verdict: 'PASS' } as CategoryResult]),
    ) as Record<CategoryId, CategoryResult>;
    return { ...base, ...partial };
  }

  it('blockingReasons lists FAIL, NEEDS_SIGNOFF and ratchet', () => {
    const c = cats({
      code_smells: { score: 1.0, confidence: 0.9, weighted: 1.1, zone: 'FAIL', gated: true, verdict: 'FAIL' },
      duplication: { score: 1.0, confidence: 0.3, weighted: 1.7, zone: 'FAIL', gated: true, verdict: 'NEEDS_SIGNOFF' },
      testability: { score: 2.4, confidence: 0.9, weighted: 2.36, zone: 'WARN', gated: true, verdict: 'WARN', ratchetRegression: { baseline: 3.0, drop: 0.6 } },
    });
    const overall = { mean: 1.9, mean100: 48, zone: 'FAIL' as const };
    const reasons = blockingReasons(c, overall, config);
    expect(reasons.some((r) => r.includes('code_smells: FAIL'))).toBe(true);
    expect(reasons.some((r) => r.includes('duplication: needs human sign-off'))).toBe(true);
    expect(reasons.some((r) => r.includes('testability: ratchet regression'))).toBe(true);
    expect(reasons.some((r) => r.includes('overall: FAIL'))).toBe(true);
  });

  it('warnNotes lists WARN zones only', () => {
    const c = cats({ code_smells: { score: 2.0, confidence: 0.9, weighted: 2.0, zone: 'WARN', gated: true, verdict: 'WARN' } });
    const notes = warnNotes(c, { mean: 3.0, mean100: 75, zone: 'PASS' }, config);
    expect(notes.some((n) => n.includes('code_smells: WARN'))).toBe(true);
  });

  it('advisoryNotes flags a low security score with the human-review wording', () => {
    const advisoryConfig = makeConfig({ gatingCategories: ['code_smells'], advisoryCategories: ['security'] });
    const c = cats({ security: { score: 1.0, confidence: 0.9, weighted: 1.1, zone: 'FAIL', gated: false, verdict: 'WARN' } });
    const notes = advisoryNotes(c, advisoryConfig);
    expect(notes.some((n) => n.includes('security') && n.includes('human security review'))).toBe(true);
  });

  it('verdictFromReasons: reasons win over warns win over pass', () => {
    expect(verdictFromReasons(['x'], ['y'])).toBe('FAIL');
    expect(verdictFromReasons([], ['y'])).toBe('WARN');
    expect(verdictFromReasons([], [])).toBe('PASS');
  });
});

describe('signoffKey', () => {
  it('is path::category', () => {
    expect(signoffKey('src/a.ts', 'security')).toBe('src/a.ts::security');
  });
});
