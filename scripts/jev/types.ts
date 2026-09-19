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

export interface JevScorer {
  /** Static info for the report, independent of availability. */
  readonly info: JevScorerInfo;
  /** Whether the scorer has what it needs (e.g. an API key) to make real calls. */
  available(): boolean;
  /** Score one file's full content. Throws on an unrecoverable per-file failure — the caller catches per file, one bad file must not fail the run. */
  score(req: JevScoreRequest): Promise<JevFileScore>;
}
