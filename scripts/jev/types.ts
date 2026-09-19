/**
 * Shared contract between gate-policy.ts (pure classification), jev-client.ts
 * (Jev transport), and gate-run.ts (orchestration/CLI). Fixed up front so the
 * three modules are built against the same shapes without importing each
 * other's internals.
 */

export const JEV_CATEGORIES = [
  'code_smells',
  'security',
  'complexity_clean_code',
  'comments',
  'testability',
  'duplication',
  'error_handling',
] as const;

export type JevCategory = (typeof JEV_CATEGORIES)[number];

/** One file's raw Jev scores, before any gate policy is applied. */
export interface JevFileScore {
  path: string;
  categories: Record<JevCategory, number>;
  confidence: Record<JevCategory, number>;
  latencyMs: number;
  costUsd: number;
  inputTokens: number;
}

export interface JevScoreRequest {
  path: string;
  content: string;
}

/** The provider/model a scorer used, surfaced in the report. */
export interface JevScorerInfo {
  provider: string;
  model: string;
}

/**
 * The injectable seam `gate-run.ts` calls through. `createHttpJevScorer()`
 * (in jev-client.ts) is the real implementation; tests supply a fake so no
 * unit test makes a live network call.
 */
export interface JevScorer {
  /** Static info for the report, independent of availability. */
  readonly info: JevScorerInfo;
  /** Whether the scorer has what it needs (e.g. an API key) to make real calls. */
  available(): boolean;
  /** Score one file's full content. Throws on an unrecoverable per-file failure — the caller catches per file, one bad file must not fail the run. */
  score(req: JevScoreRequest): Promise<JevFileScore>;
}
