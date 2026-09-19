/**
 * Domain types for the Jev CI gate. Kept separate from logic so the shape of
 * a score, a verdict, and the config is defined in exactly one place —
 * see /home/workspace/reports/jev-thresholds-proposal.md for the policy this
 * encodes.
 */

/** The 7 Jev rubric categories, 0 (worst) to 4 (best). */
export const ALL_CATEGORIES = [
  'complexity_clean_code',
  'code_smells',
  'duplication',
  'testability',
  'error_handling',
  'security',
  'comments',
] as const;
export type CategoryId = (typeof ALL_CATEGORIES)[number];

export type Zone = 'FAIL' | 'WARN' | 'PASS';

/** A category's blocking status after zone, confidence, exemption, and ratchet are applied. */
export type CategoryVerdict = 'PASS' | 'WARN' | 'FAIL' | 'NEEDS_SIGNOFF' | 'EXEMPT';

export type FileVerdict = 'PASS' | 'WARN' | 'FAIL' | 'SKIPPED' | 'ERROR';

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

export interface GateConfig {
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
  overall: number;
}

export type Baseline = Record<string, BaselineEntry>;

export interface CategoryResult {
  score: number;
  confidence: number;
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
  base: string;
  mergeBase: string;
  filesChanged: number;
  filesScored: number;
  filesSkipped: number;
  filesErrored: number;
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
