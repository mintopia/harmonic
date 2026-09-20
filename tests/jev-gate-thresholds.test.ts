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
  it('a confident FAIL blocks', () => {
    const r = evalCat('code_smells', 1.0, 0.9); // confidence >= blockingMin, raw 1.0 -> FAIL
    expect(r.unsure).toBe(false);
    expect(r.zone).toBe('FAIL');
    expect(r.gated).toBe(true);
    expect(r.verdict).toBe('FAIL');
  });

  it('a low-confidence score is unsure and needs sign-off, whatever the score', () => {
    const r = evalCat('code_smells', 1.0, 0.4); // confidence < blockingMin 0.6
    expect(r.unsure).toBe(true);
    expect(r.verdict).toBe('NEEDS_SIGNOFF');
  });

  it('a signed-off unsure category is downgraded to WARN', () => {
    const r = evalCat('code_smells', 1.0, 0.4, { signoffs: new Set([signoffKey('src/foo.ts', 'code_smells')]) });
    expect(r.verdict).toBe('WARN');
    expect(r.signoffAcknowledged).toBe(true);
  });

  it('even a high raw score is unsure when confidence is low', () => {
    const r = evalCat('code_smells', 4.0, 0.4);
    expect(r.unsure).toBe(true);
    expect(r.zone).toBe('PASS'); // the raw zone is still computed for display
    expect(r.verdict).toBe('NEEDS_SIGNOFF');
  });

  it('confident WARN and PASS zones map straight through', () => {
    expect(evalCat('code_smells', 2.0, 0.9).verdict).toBe('WARN');
    expect(evalCat('code_smells', 3.5, 0.9).verdict).toBe('PASS');
  });

  it('a missing answer scores 0/0 and is unsure (needs sign-off)', () => {
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
    expect(r.unsure).toBe(true);
    expect(r.verdict).toBe('NEEDS_SIGNOFF');
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
    const role: RoleMatch = { roleName: 'test', skip: false, exempt: new Set<CategoryId>(['error_handling']), hint: undefined };
    const r = evalCat('error_handling', 1.0, 0.9, { role });
    expect(r.gated).toBe(false);
    expect(r.verdict).toBe('WARN');
  });
});

describe('evaluateCategory — ratchet regression', () => {
  const baseline: Baseline[string] = { categories: { code_smells: 3.0, testability: 3.0 }, overall: 3.0 };

  it('flags a drop >= categoryDrop on a gated axis (raw current vs raw baseline)', () => {
    const r = evalCat('code_smells', 2.4, 0.9, { baseline }); // raw 2.4 vs baseline 3.0 -> drop 0.6
    expect(r.ratchetRegression).toEqual({ baseline: 3.0, drop: expect.closeTo(0.6, 5) });
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
      ALL_CATEGORIES.map((c) => [c, { score: 3.0, confidence: 0.9, unsure: false, zone: 'PASS', gated: true, verdict: 'PASS' } as CategoryResult]),
    ) as Record<CategoryId, CategoryResult>;
    return { ...base, ...partial };
  }

  it('blockingReasons lists FAIL, NEEDS_SIGNOFF and ratchet', () => {
    const c = cats({
      code_smells: { score: 1.0, confidence: 0.9, unsure: false, zone: 'FAIL', gated: true, verdict: 'FAIL' },
      error_handling: { score: 1.0, confidence: 0.3, unsure: true, zone: 'FAIL', gated: true, verdict: 'NEEDS_SIGNOFF' },
      testability: { score: 2.4, confidence: 0.9, unsure: false, zone: 'WARN', gated: true, verdict: 'WARN', ratchetRegression: { baseline: 3.0, drop: 0.6 } },
    });
    const overall = { mean: 1.9, mean100: 48, zone: 'FAIL' as const };
    const reasons = blockingReasons(c, overall, config);
    expect(reasons.some((r) => r.includes('code_smells: FAIL'))).toBe(true);
    expect(reasons.some((r) => r.includes('error_handling: unsure — needs human sign-off'))).toBe(true);
    expect(reasons.some((r) => r.includes('testability: ratchet regression'))).toBe(true);
    expect(reasons.some((r) => r.includes('overall: FAIL'))).toBe(true);
  });

  it('warnNotes lists WARN zones only', () => {
    const c = cats({ code_smells: { score: 2.0, confidence: 0.9, unsure: false, zone: 'WARN', gated: true, verdict: 'WARN' } });
    const notes = warnNotes(c, { mean: 3.0, mean100: 75, zone: 'PASS' }, config);
    expect(notes.some((n) => n.includes('code_smells: WARN'))).toBe(true);
  });

  it('advisoryNotes flags a low security score with the human-review wording', () => {
    const advisoryConfig = makeConfig({ gatingCategories: ['code_smells'], advisoryCategories: ['security'] });
    const c = cats({ security: { score: 1.0, confidence: 0.9, unsure: false, zone: 'FAIL', gated: false, verdict: 'WARN' } });
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
