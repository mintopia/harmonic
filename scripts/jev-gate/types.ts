/**
 * Domain types for the Jev CI gate. Kept separate from logic so the shape of
 * a score, a verdict, and the config is defined in exactly one place —
 * see /home/workspace/reports/jev-thresholds-proposal.md for the policy this
 * encodes.
 */

/** The 8 Jev rubric categories, 0 (worst) to 4 (best). */
export const ALL_CATEGORIES = [
  'complexity_clean_code',
  'code_smells',
  'duplication',
  'testability',
  'error_handling',
  'security',
  'comments',
  'concurrency_and_idempotency',
] as const;
export type CategoryId = (typeof ALL_CATEGORIES)[number];

export type Zone = 'FAIL' | 'WARN' | 'PASS';

/** A category's blocking status after zone, confidence, exemption, and ratchet are applied. */
export type CategoryVerdict = 'PASS' | 'WARN' | 'FAIL' | 'NEEDS_SIGNOFF' | 'EXEMPT';

export type FileVerdict = 'PASS' | 'WARN' | 'FAIL' | 'SKIPPED' | 'ERROR' | 'TOO_BIG';

export interface CategoryZoneThresholds {
  fail: number;
  warn: number;
}

export interface OverallZoneThresholds {
  fail: number;
  warn: number;
}

export interface ConfidenceThresholds {
  blockingMin: number;
}

export interface RatchetThresholds {
  categoryDrop: number;
  overallDrop: number;
}

export interface GateThresholds {
  category: CategoryZoneThresholds;
  overall: OverallZoneThresholds;
  confidence: ConfidenceThresholds;
  ratchet: RatchetThresholds;
}

export interface RoleRule {
  name: string;
  glob: string[];
  /** When true every category is skipped: the file is never sent to Jev. */
  skip?: boolean;
  /** Categories suppressed from gating for this role (still scored/shown advisory). */
  exempt?: CategoryId[];
  /** Text attached to the Jev call as `state.role_hint`. */
  hint?: string;
}

export type GateMode = 'advisory' | 'enforcing';

export interface GateConfig {
  /** advisory = always exit 0 (report only); enforcing = exit 1 on a failing verdict. */
  mode: GateMode;
  thresholds: GateThresholds;
  gatingCategories: CategoryId[];
  advisoryCategories: CategoryId[];
  roles: RoleRule[];
  sourceExtensions: string[];
  skipDirs: string[];
  baselinePath: string;
  maxFileBytes: number;
  chunkChars: number;
  diffCharBudget: number;
  defaultConcurrency: number;
}

export interface RubricQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type Rubrics = Record<CategoryId, RubricQuestion>;

export interface RoleMatch {
  roleName: string;
  skip: boolean;
  exempt: ReadonlySet<CategoryId>;
  hint: string | undefined;
}

export interface JevAnswer {
  score: number;
  confidence: number;
}

export interface JevUsage {
  cost?: number;
  input_tokens?: number;
}

export interface BaselineEntry {
  categories: Partial<Record<CategoryId, number>>;
  /** Jev's self-reported confidence (0-1) per category, parallel to `categories`.
   * Optional: baselines written before confidence was captured omit it, and the
   * renderer/weighting fall back to raw scores when it is absent. */
  confidences?: Partial<Record<CategoryId, number>>;
  /** Mean of the raw category scores. */
  overall: number;
}

export type Baseline = Record<string, BaselineEntry>;

/** Run-level facts about the scoring pass that produced a baseline, surfaced in
 * the HTML report. Persisted alongside the file map so a render-only pass can
 * still show them. Cost/tokens are best-effort — the provider may not report
 * them, in which case they are null. */
export interface BaselineMeta {
  generatedAt: string;
  model: string;
  provider: string;
  concurrency: number;
  durationMs: number;
  /** Successful Jev API calls (one POST per scored file). */
  apiCalls: number;
  filesScored: number;
  totalCostUsd: number | null;
  totalInputTokens: number | null;
}

/** On-disk baseline shape (current). Legacy baselines are a bare
 * {@link Baseline} map with no wrapper; {@link loadBaseline} reads both. */
export interface BaselineFile {
  meta: BaselineMeta | null;
  files: Baseline;
}

export interface CategoryResult {
  /** Jev's raw 0-4 score, as reported. */
  score: number;
  confidence: number;
  /** Confidence is below the gate's confidence floor: the score can't be
   * trusted, so a gating axis reads NEEDS_SIGNOFF ("unsure — a human must look")
   * rather than pass/warn/fail. */
  unsure: boolean;
  /** Score zone (from the raw score); meaningful for display when not `unsure`. */
  zone: Zone;
  gated: boolean;
  verdict: CategoryVerdict;
  ratchetRegression?: {
    baseline: number;
    drop: number;
  };
  signoffAcknowledged?: boolean;
}

export interface OverallResult {
  mean: number;
  mean100: number;
  zone: Zone;
  ratchetRegression?: {
    baseline: number;
    drop: number;
  };
}

export interface FileResult {
  path: string;
  role: string;
  roleHint?: string;
  verdict: FileVerdict;
  skipReason?: string;
  error?: string;
  categories?: Record<CategoryId, CategoryResult>;
  overall?: OverallResult;
  reasons: string[];
  advisories: string[];
  hasBaseline: boolean;
}

export interface GateSummary {
  mode: GateMode;
  base: string;
  mergeBase: string;
  filesChanged: number;
  filesScored: number;
  filesSkipped: number;
  filesErrored: number;
  filesTooBig: number;
  baselinePath: string;
  baselineExists: boolean;
  verdict: 'PASS' | 'FAIL';
  failingFiles: string[];
  needsSignoffFiles: string[];
  warnFiles: string[];
  notes: string[];
}

export interface GateResult {
  generatedAt: string;
  model: string;
  provider: string;
  summary: GateSummary;
  files: FileResult[];
}
