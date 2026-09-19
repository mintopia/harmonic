/**
 * Pure threshold logic: turns a raw score + confidence + role exemption +
 * baseline into a `CategoryVerdict` / `FileVerdict`. No I/O here — this is the
 * "deterministic given the scores" half of the gate (see scripts/jev-gate/README.md
 * for what "deterministic" does and does not mean).
 */
import type {
  Baseline,
  CategoryId,
  CategoryResult,
  CategoryVerdict,
  GateConfig,
  JevAnswer,
  OverallResult,
  RoleMatch,
  Zone,
} from './types.js';
import { ALL_CATEGORIES } from './types.js';

export function categoryZone(score: number, t: GateConfig['thresholds']['category']): Zone {
  if (score < t.fail) return 'FAIL';
  if (score < t.warn) return 'WARN';
  return 'PASS';
}

export function overallZone(mean: number, t: GateConfig['thresholds']['overall']): Zone {
  if (mean < t.fail) return 'FAIL';
  if (mean < t.warn) return 'WARN';
  return 'PASS';
}

/**
 * A signoff acknowledgement token is `path::category`. It exists so the "FAIL
 * with confidence < 0.6" case (proposal §3) — which blocks until a human
 * clears it — has a concrete way to be cleared from CI: an operator re-runs
 * the gate with `--signoff path::category` (or `$JEV_GATE_SIGNOFF`) once
 * they've looked at the flagged file.
 */
export function signoffKey(path: string, category: CategoryId): string {
  return `${path}::${category}`;
}

export interface CategoryEvalInput {
  path: string;
  category: CategoryId;
  answer: JevAnswer | undefined;
  role: RoleMatch;
  config: GateConfig;
  baseline: Baseline[string] | undefined;
  signoffs: ReadonlySet<string>;
}

/** Evaluate one category for one file: zone, confidence gating, exemption, ratchet. */
export function evaluateCategory(input: CategoryEvalInput): CategoryResult {
  const { path, category, answer, role, config, baseline, signoffs } = input;
  const score = typeof answer?.score === 'number' ? answer.score : 0;
  const confidence = typeof answer?.confidence === 'number' ? answer.confidence : 0;
  const zone = categoryZone(score, config.thresholds.category);
  const isGatingAxis = config.gatingCategories.includes(category);
  const gated = isGatingAxis && !role.exempt.has(category);

  const result: CategoryResult = { score, confidence, zone, gated, verdict: 'EXEMPT' };

  if (!gated) {
    // Advisory-only axis (security/comments), or a gating axis role-exempted
    // for this file: the true `zone` stays visible for advisory display, but
    // the verdict itself can never be FAIL here — see proposal §1 and §4.
    result.verdict = zone === 'PASS' ? 'PASS' : 'WARN';
  } else if (zone === 'PASS') {
    result.verdict = 'PASS';
  } else if (zone === 'WARN') {
    result.verdict = 'WARN';
  } else {
    // zone === 'FAIL'
    if (confidence >= config.thresholds.confidence.blockingMin) {
      result.verdict = 'FAIL';
    } else {
      const key = signoffKey(path, category);
      result.verdict = signoffs.has(key) ? 'WARN' : 'NEEDS_SIGNOFF';
      if (signoffs.has(key)) result.signoffAcknowledged = true;
    }
  }

  if (gated && baseline) {
    const baselineScore = baseline.categories[category];
    if (typeof baselineScore === 'number' && score <= baselineScore - config.thresholds.ratchet.categoryDrop) {
      result.ratchetRegression = { baseline: baselineScore, drop: baselineScore - score };
    }
  }

  return result;
}

export function evaluateOverall(
  categoryScores: Record<CategoryId, number>,
  config: GateConfig,
  baseline: Baseline[string] | undefined,
): OverallResult {
  const values = ALL_CATEGORIES.map((c) => categoryScores[c]);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const zone = overallZone(mean, config.thresholds.overall);
  const result: OverallResult = { mean, mean100: Math.round((mean / 4) * 100), zone };
  if (baseline && mean <= baseline.overall - config.thresholds.ratchet.overallDrop) {
    result.ratchetRegression = { baseline: baseline.overall, drop: baseline.overall - mean };
  }
  return result;
}

/** Zones that must block a file, and why — used to build the human-readable reasons list. */
export function blockingReasons(
  categories: Record<CategoryId, CategoryResult>,
  overall: OverallResult,
  config: GateConfig,
): string[] {
  const reasons: string[] = [];
  for (const cat of config.gatingCategories) {
    const c = categories[cat];
    if (!c) continue;
    if (c.verdict === 'FAIL') reasons.push(`${cat}: FAIL (${c.score.toFixed(1)}/4, confidence ${c.confidence.toFixed(2)})`);
    if (c.verdict === 'NEEDS_SIGNOFF') reasons.push(`${cat}: needs human sign-off (${c.score.toFixed(1)}/4, low confidence ${c.confidence.toFixed(2)})`);
    if (c.ratchetRegression) {
      reasons.push(`${cat}: ratchet regression, dropped ${c.ratchetRegression.drop.toFixed(2)} vs baseline ${c.ratchetRegression.baseline.toFixed(2)}`);
    }
  }
  if (overall.zone === 'FAIL') reasons.push(`overall: FAIL (${overall.mean100}/100)`);
  if (overall.ratchetRegression) {
    reasons.push(`overall: ratchet regression, dropped ${overall.ratchetRegression.drop.toFixed(2)} vs baseline ${overall.ratchetRegression.baseline.toFixed(2)}`);
  }
  return reasons;
}

export function warnNotes(categories: Record<CategoryId, CategoryResult>, overall: OverallResult, config: GateConfig): string[] {
  const notes: string[] = [];
  for (const cat of config.gatingCategories) {
    const c = categories[cat];
    if (c && c.verdict === 'WARN') notes.push(`${cat}: WARN (${c.score.toFixed(1)}/4)`);
  }
  if (overall.zone === 'WARN') notes.push(`overall: WARN (${overall.mean100}/100)`);
  return notes;
}

/** Security/comments never gate; `security` additionally raises a human-review flag on a low score. */
export function advisoryNotes(categories: Record<CategoryId, CategoryResult>, config: GateConfig): string[] {
  const notes: string[] = [];
  for (const cat of config.advisoryCategories) {
    const c = categories[cat];
    if (!c) continue;
    if (cat === 'security' && c.zone !== 'PASS') {
      notes.push(`security: ${c.zone} (${c.score.toFixed(1)}/4) — advisory only, flagged for human security review, does not block`);
    } else if (c.zone !== 'PASS') {
      notes.push(`${cat}: ${c.zone} (${c.score.toFixed(1)}/4) — advisory only, does not block`);
    }
  }
  return notes;
}

export function verdictFromReasons(reasons: string[], warns: string[]): 'PASS' | 'WARN' | 'FAIL' {
  if (reasons.length > 0) return 'FAIL';
  if (warns.length > 0) return 'WARN';
  return 'PASS';
}

/** Category verdicts that should count as blocking for the file (used by the caller to build `reasons`). */
export function isBlockingVerdict(v: CategoryVerdict): boolean {
  return v === 'FAIL' || v === 'NEEDS_SIGNOFF';
}
