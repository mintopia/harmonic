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
 * A signoff acknowledgement token is `path::category`. An "unsure" gating
 * category (confidence below the floor) blocks as NEEDS_SIGNOFF until a human
 * clears it: an operator re-runs the gate with `--signoff path::category` (or
 * `$JEV_GATE_SIGNOFF`) once they've looked at the flagged file.
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

/**
 * Judge one category from its RAW score, gated by confidence. Below the
 * confidence floor the score is "unsure": a gating axis reads NEEDS_SIGNOFF (a
 * human must look), because we can't trust the number either way — this
 * generalises the old "low-confidence FAIL needs sign-off" to any low-confidence
 * score. At or above the floor the raw score decides PASS/WARN/FAIL.
 */
export function evaluateCategory(input: CategoryEvalInput): CategoryResult {
  const { path, category, answer, role, config, baseline, signoffs } = input;
  const score = typeof answer?.score === 'number' ? answer.score : 0;
  const confidence = typeof answer?.confidence === 'number' ? answer.confidence : 0;
  const unsure = confidence < config.thresholds.confidence.blockingMin;
  const zone = categoryZone(score, config.thresholds.category);
  const isGatingAxis = config.gatingCategories.includes(category);
  const gated = isGatingAxis && !role.exempt.has(category);

  const result: CategoryResult = { score, confidence, unsure, zone, gated, verdict: 'EXEMPT' };

  if (!gated) {
    // Advisory-only axis (security/comments), or a gating axis role-exempted for
    // this file: the true `zone` stays visible, but the verdict can never FAIL.
    result.verdict = zone === 'PASS' ? 'PASS' : 'WARN';
  } else if (unsure) {
    // Confidence too low to trust the score: a human confirms (or has).
    const key = signoffKey(path, category);
    result.verdict = signoffs.has(key) ? 'WARN' : 'NEEDS_SIGNOFF';
    if (signoffs.has(key)) result.signoffAcknowledged = true;
  } else {
    result.verdict = zone === 'FAIL' ? 'FAIL' : zone === 'WARN' ? 'WARN' : 'PASS';
  }

  if (gated && baseline) {
    const baselineScore = baseline.categories[category];
    if (typeof baselineScore === 'number' && score <= baselineScore - config.thresholds.ratchet.categoryDrop) {
      result.ratchetRegression = { baseline: baselineScore, drop: baselineScore - score };
    }
  }

  return result;
}

/** The overall is the mean of the raw scores for categories that were asked
 * (role-exempt categories are absent from `scores` and excluded from the mean);
 * the ratchet compares it against the baseline's stored overall. */
export function evaluateOverall(
  scores: Partial<Record<CategoryId, number>>,
  config: GateConfig,
  baseline: Baseline[string] | undefined,
): OverallResult {
  const values = Object.values(scores);
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const zone = overallZone(mean, config.thresholds.overall);
  const result: OverallResult = { mean, mean100: Math.round((mean / 4) * 100), zone };
  if (baseline && mean <= baseline.overall - config.thresholds.ratchet.overallDrop) {
    result.ratchetRegression = { baseline: baseline.overall, drop: baseline.overall - mean };
  }
  return result;
}

/** Zones that must block a file, and why — used to build the human-readable reasons list. */
export function blockingReasons(
  categories: Partial<Record<CategoryId, CategoryResult>>,
  overall: OverallResult,
  config: GateConfig,
): string[] {
  const reasons: string[] = [];
  for (const cat of config.gatingCategories) {
    const c = categories[cat];
    if (!c) continue;
    const decidedSuffix = c.decidedBy ? `, decided by ${c.decidedBy}` : '';
    if (c.verdict === 'FAIL') reasons.push(`${cat}: FAIL (${c.score.toFixed(1)}/4, confidence ${c.confidence.toFixed(2)}${decidedSuffix})`);
    if (c.verdict === 'NEEDS_SIGNOFF') reasons.push(`${cat}: unsure — needs human sign-off (${c.score.toFixed(1)}/4, low confidence ${c.confidence.toFixed(2)}${decidedSuffix})`);
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

export function warnNotes(categories: Partial<Record<CategoryId, CategoryResult>>, overall: OverallResult, config: GateConfig): string[] {
  const notes: string[] = [];
  for (const cat of config.gatingCategories) {
    const c = categories[cat];
    if (c && c.verdict === 'WARN') notes.push(`${cat}: WARN (${c.score.toFixed(1)}/4)`);
  }
  if (overall.zone === 'WARN') notes.push(`overall: WARN (${overall.mean100}/100)`);
  return notes;
}

/** Security/comments never gate; `security` additionally raises a human-review flag on a low score. */
export function advisoryNotes(categories: Partial<Record<CategoryId, CategoryResult>>, config: GateConfig): string[] {
  const notes: string[] = [];
  for (const cat of config.advisoryCategories) {
    const c = categories[cat];
    if (!c) continue;
    const decidedSuffix = c.decidedBy ? `, decided by ${c.decidedBy}` : '';
    if (cat === 'security' && c.zone !== 'PASS') {
      notes.push(`security: ${c.zone} (${c.score.toFixed(1)}/4${decidedSuffix}) — advisory only, flagged for human security review, does not block`);
    } else if (c.zone !== 'PASS') {
      notes.push(`${cat}: ${c.zone} (${c.score.toFixed(1)}/4${decidedSuffix}) — advisory only, does not block`);
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
