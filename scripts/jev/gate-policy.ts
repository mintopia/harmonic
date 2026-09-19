import { matchesGlob, sep as pathSep } from 'node:path';
import { z } from 'zod';
import { JEV_CATEGORIES, type JevCategory, type JevFileScore } from './types.js';

const PERMANENTLY_ADVISORY_CATEGORIES: readonly JevCategory[] = ['security', 'comments'];

// A "true" 0.5 drop can arrive as a float like 0.49999999999999994 (e.g.
// 1.9 - 1.4). Without an epsilon that would wrongly fail to trip the ratchet.
const RATCHET_EPSILON = 1e-9;

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function fmt2(value: number): string {
  return value.toFixed(2);
}

function fmtPct(value: number): string {
  return String(Math.round(value));
}

const jevCategorySchema = z.enum(JEV_CATEGORIES);

const exemptionSchema = z
  .object({
    glob: z.string(),
    suppress: z.union([z.literal('all'), z.array(jevCategorySchema)]),
  })
  .strict();

const enforceSchema = z
  .object({
    newFileAbsolutes: z.boolean(),
    modifiedFileAbsolutes: z.boolean(),
    ratchet: z.boolean(),
  })
  .strict();

const categoryZonesSchema = z
  .object({
    failBelow: z.number(),
    passAtOrAbove: z.number(),
  })
  .strict();

const overallZonesSchema = z
  .object({
    failBelow: z.number(),
    passAtOrAbove: z.number(),
    skipWhenExempt: z.boolean(),
  })
  .strict();

const confidenceConfigSchema = z
  .object({
    hardFailMin: z.number(),
  })
  .strict();

const ratchetMarginsSchema = z
  .object({
    categoryDrop: z.number(),
    overallDrop: z.number(),
  })
  .strict();

const scanConfigSchema = z
  .object({
    defaultBase: z.string(),
    sourceExtensions: z.array(z.string()),
    maxFiles: z.number(),
    maxFileBytes: z.number(),
    concurrency: z.number(),
  })
  .strict();

export const gateConfigSchema = z
  .object({
    mode: z.enum(['advisory', 'enforcing']),
    enforce: enforceSchema,
    gatedCategories: z.array(jevCategorySchema),
    categoryZones: categoryZonesSchema,
    overallZones: overallZonesSchema,
    confidence: confidenceConfigSchema,
    ratchetMargins: ratchetMarginsSchema,
    exemptions: z.array(exemptionSchema),
    scan: scanConfigSchema,
    onInfrastructureError: z.enum(['skip', 'fail']),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const category of PERMANENTLY_ADVISORY_CATEGORIES) {
      if (config.gatedCategories.includes(category)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gatedCategories'],
          message: '"security" and "comments" can never be gated — they are permanently advisory-only',
        });
      }
    }
  });

export type GateConfig = z.infer<typeof gateConfigSchema>;

export function parseGateConfig(raw: unknown): GateConfig {
  return gateConfigSchema.parse(raw);
}

function advisoryCategoriesOf(config: GateConfig): JevCategory[] {
  return JEV_CATEGORIES.filter((category) => !config.gatedCategories.includes(category));
}

const baselineEntrySchema = z.object({
  categories: z.partialRecord(jevCategorySchema, z.number()),
  confidence: z.partialRecord(jevCategorySchema, z.number()),
  overall: z.number().nullable(),
});

export interface BaselineEntry {
  categories: Partial<Record<JevCategory, number>>;
  confidence: Partial<Record<JevCategory, number>>;
  overall: number | null;
}

const baselineSchema = z.object({
  generatedAt: z.string().nullable().optional().default(null),
  commit: z.string().nullable().optional().default(null),
  provider: z.string().nullable().optional().default(null),
  model: z.string().nullable().optional().default(null),
  files: z.record(z.string(), baselineEntrySchema).optional().default({}),
});

export interface Baseline {
  generatedAt: string | null;
  commit: string | null;
  provider: string | null;
  model: string | null;
  files: Record<string, BaselineEntry>;
}

export function parseBaseline(raw: unknown): Baseline {
  const parsed = baselineSchema.parse(raw);
  return {
    generatedAt: parsed.generatedAt,
    commit: parsed.commit,
    provider: parsed.provider,
    model: parsed.model,
    files: parsed.files,
  };
}

export interface PathClassification {
  excluded: boolean;
  exclusionReason: string | null;
  exemptCategories: JevCategory[];
  matchedExemptions: string[];
}

function toPosixRelative(repoRelativePath: string): string {
  return pathSep === '/' ? repoRelativePath : repoRelativePath.split(pathSep).join('/');
}

export function classifyPath(repoRelativePath: string, config: GateConfig): PathClassification {
  const normalized = toPosixRelative(repoRelativePath);
  const matchedExemptions: string[] = [];
  const exemptCategories = new Set<JevCategory>();
  let exclusionReason: string | null = null;

  for (const rule of config.exemptions) {
    if (!matchesGlob(normalized, rule.glob)) continue;
    matchedExemptions.push(rule.glob);
    if (rule.suppress === 'all') {
      exclusionReason ??= rule.glob;
    } else {
      for (const category of rule.suppress) exemptCategories.add(category);
    }
  }

  if (exclusionReason !== null) {
    return { excluded: true, exclusionReason, exemptCategories: [], matchedExemptions };
  }
  return { excluded: false, exclusionReason: null, exemptCategories: [...exemptCategories], matchedExemptions };
}

export type Zone = 'pass' | 'warn' | 'fail';

export function classifyScore(
  score: number,
  confidence: number,
  zones: { failBelow: number; passAtOrAbove: number },
  hardFailMin: number,
): { zone: Zone; downgraded: boolean } {
  if (score >= zones.passAtOrAbove) return { zone: 'pass', downgraded: false };
  if (score >= zones.failBelow) return { zone: 'warn', downgraded: false };
  if (confidence >= hardFailMin) return { zone: 'fail', downgraded: false };
  return { zone: 'warn', downgraded: true };
}

function classifyOverallZone(score: number, zones: { failBelow: number; passAtOrAbove: number }): Zone {
  if (score >= zones.passAtOrAbove) return 'pass';
  if (score >= zones.failBelow) return 'warn';
  return 'fail';
}

export interface CategoryJudgement {
  score: number;
  confidence: number;
  zone: Zone;
  gated: boolean;
  exempt: boolean;
  advisory: boolean;
  downgraded: boolean;
  baseline: number | null;
  delta: number | null;
  ratchetFail: boolean;
}

export interface OverallJudgement {
  score: number;
  score100: number;
  zone: Zone;
  gated: boolean;
  baseline: number | null;
  delta: number | null;
  ratchetFail: boolean;
}

export interface FileJudgement {
  path: string;
  status: 'scored' | 'excluded' | 'error';
  baselineStatus: 'new' | 'modified';
  verdict: Zone;
  blocking: boolean;
  needsHumanSignOff: boolean;
  exclusionReason: string | null;
  exemptCategories: JevCategory[];
  matchedExemptions: string[];
  overall: OverallJudgement | null;
  categories: Record<JevCategory, CategoryJudgement> | null;
  reasons: string[];
  error: string | null;
  latencyMs: number | null;
}

function judgeCategory(
  category: JevCategory,
  score: JevFileScore,
  classification: PathClassification,
  baselineEntry: BaselineEntry | undefined,
  config: GateConfig,
): CategoryJudgement {
  const rawScore = score.categories[category];
  const rawConfidence = score.confidence[category];
  const exempt = classification.exemptCategories.includes(category);
  const advisory = PERMANENTLY_ADVISORY_CATEGORIES.includes(category) || !config.gatedCategories.includes(category);
  const gated = !advisory && !exempt;

  const { zone, downgraded } = classifyScore(rawScore, rawConfidence, config.categoryZones, config.confidence.hardFailMin);

  const baselineScore = baselineEntry?.categories[category] ?? null;
  const rawDelta = baselineScore !== null ? rawScore - baselineScore : null;
  const ratchetFail =
    gated && baselineScore !== null && baselineScore - rawScore >= config.ratchetMargins.categoryDrop - RATCHET_EPSILON;

  return {
    score: round2(rawScore),
    confidence: round2(rawConfidence),
    zone,
    gated,
    exempt,
    advisory,
    downgraded,
    baseline: baselineScore !== null ? round2(baselineScore) : null,
    delta: rawDelta !== null ? round2(rawDelta) : null,
    ratchetFail,
  };
}

function computeOverallScore(score: JevFileScore): number {
  const total = JEV_CATEGORIES.reduce((sum, category) => sum + score.categories[category], 0);
  return total / JEV_CATEGORIES.length;
}

function judgeOverall(
  score: JevFileScore,
  classification: PathClassification,
  baselineEntry: BaselineEntry | undefined,
  config: GateConfig,
): OverallJudgement {
  const rawOverall = computeOverallScore(score);
  const zone = classifyOverallZone(rawOverall, config.overallZones);
  const partiallyExempt = classification.exemptCategories.length > 0;
  const gated = !(partiallyExempt && config.overallZones.skipWhenExempt);

  const baselineOverall = baselineEntry?.overall ?? null;
  const rawDelta = baselineOverall !== null ? rawOverall - baselineOverall : null;
  const ratchetFail =
    gated &&
    baselineOverall !== null &&
    baselineOverall - rawOverall >= config.ratchetMargins.overallDrop - RATCHET_EPSILON;

  return {
    score: round2(rawOverall),
    score100: round2((rawOverall / 4) * 100),
    zone,
    gated,
    baseline: baselineOverall !== null ? round2(baselineOverall) : null,
    delta: rawDelta !== null ? round2(rawDelta) : null,
    ratchetFail,
  };
}

function buildReasons(
  categories: Record<JevCategory, CategoryJudgement>,
  overall: OverallJudgement,
  config: GateConfig,
): string[] {
  const reasons: string[] = [];

  for (const category of JEV_CATEGORIES) {
    const judgement = categories[category];
    if (judgement.downgraded) {
      reasons.push(
        `${category} ${fmt2(judgement.score)} below fail threshold ${fmt2(config.categoryZones.failBelow)} but confidence ${fmt2(judgement.confidence)} < ${fmt2(config.confidence.hardFailMin)} -> downgraded to WARN, needs human sign-off`,
      );
    } else if (judgement.gated && judgement.zone === 'fail') {
      reasons.push(
        `${category} ${fmt2(judgement.score)} below fail threshold ${fmt2(config.categoryZones.failBelow)} with confidence ${fmt2(judgement.confidence)} >= ${fmt2(config.confidence.hardFailMin)} -> FAIL`,
      );
    } else if (judgement.zone === 'warn') {
      reasons.push(
        `${category} ${fmt2(judgement.score)} in warn zone (${fmt2(config.categoryZones.failBelow)} <= score < ${fmt2(config.categoryZones.passAtOrAbove)})`,
      );
    }

    if (judgement.ratchetFail && judgement.baseline !== null) {
      const drop = round2(judgement.baseline - judgement.score);
      reasons.push(
        `${category} regressed from baseline ${fmt2(judgement.baseline)} to ${fmt2(judgement.score)} (drop ${fmt2(drop)} >= margin ${fmt2(config.ratchetMargins.categoryDrop)}) -> ratchet FAIL`,
      );
    }
  }

  const failThreshold100 = fmtPct((config.overallZones.failBelow / 4) * 100);
  const passThreshold100 = fmtPct((config.overallZones.passAtOrAbove / 4) * 100);
  if (overall.gated && overall.zone === 'fail') {
    reasons.push(`overall ${fmtPct(overall.score100)}/100 below fail threshold ${failThreshold100}/100`);
  } else if (overall.zone === 'warn') {
    reasons.push(`overall ${fmtPct(overall.score100)}/100 in warn zone (${failThreshold100}/100 <= score < ${passThreshold100}/100)`);
  }
  if (overall.ratchetFail && overall.baseline !== null) {
    const drop = round2(overall.baseline - overall.score);
    reasons.push(
      `overall regressed from baseline ${fmt2(overall.baseline)} to ${fmt2(overall.score)} (drop ${fmt2(drop)} >= margin ${fmt2(config.ratchetMargins.overallDrop)}) -> ratchet FAIL`,
    );
  }

  return reasons;
}

function decideBlocking(args: {
  mode: GateConfig['mode'];
  enforce: GateConfig['enforce'];
  baselineStatus: 'new' | 'modified';
  hasAbsoluteFail: boolean;
  hasRatchetRegression: boolean;
}): boolean {
  if (args.mode === 'advisory') return false;
  if (args.baselineStatus === 'new') {
    return args.hasAbsoluteFail && args.enforce.newFileAbsolutes;
  }
  const absoluteBlocks = args.hasAbsoluteFail && args.enforce.modifiedFileAbsolutes;
  const ratchetBlocks = args.hasRatchetRegression && args.enforce.ratchet;
  return absoluteBlocks || ratchetBlocks;
}

export function judgeFile(args: {
  score: JevFileScore;
  classification: PathClassification;
  baselineEntry: BaselineEntry | undefined;
  config: GateConfig;
  mode: GateConfig['mode'];
}): FileJudgement {
  const { score, classification, baselineEntry, config, mode } = args;

  const categories = Object.fromEntries(
    JEV_CATEGORIES.map((category) => [category, judgeCategory(category, score, classification, baselineEntry, config)]),
  ) as Record<JevCategory, CategoryJudgement>;
  const overall = judgeOverall(score, classification, baselineEntry, config);

  const hasAbsoluteFail =
    JEV_CATEGORIES.some((category) => categories[category].gated && categories[category].zone === 'fail') ||
    (overall.gated && overall.zone === 'fail');
  const hasRatchetRegression = JEV_CATEGORIES.some((category) => categories[category].ratchetFail) || overall.ratchetFail;
  const needsHumanSignOff = JEV_CATEGORIES.some((category) => categories[category].downgraded);
  const anyWarnZone = JEV_CATEGORIES.some((category) => categories[category].zone === 'warn') || overall.zone === 'warn';

  const verdict: Zone = hasAbsoluteFail || hasRatchetRegression ? 'fail' : anyWarnZone || needsHumanSignOff ? 'warn' : 'pass';
  const baselineStatus: 'new' | 'modified' = baselineEntry ? 'modified' : 'new';
  const blocking = decideBlocking({ mode, enforce: config.enforce, baselineStatus, hasAbsoluteFail, hasRatchetRegression });

  return {
    path: score.path,
    status: 'scored',
    baselineStatus,
    verdict,
    blocking,
    needsHumanSignOff,
    exclusionReason: null,
    exemptCategories: classification.exemptCategories,
    matchedExemptions: classification.matchedExemptions,
    overall,
    categories,
    reasons: buildReasons(categories, overall, config),
    error: null,
    latencyMs: score.latencyMs,
  };
}

export function excludedFileJudgement(
  path: string,
  classification: PathClassification,
  baselineEntry: BaselineEntry | undefined,
): FileJudgement {
  return {
    path,
    status: 'excluded',
    baselineStatus: baselineEntry ? 'modified' : 'new',
    verdict: 'pass',
    blocking: false,
    needsHumanSignOff: false,
    exclusionReason: classification.exclusionReason,
    exemptCategories: [],
    matchedExemptions: classification.matchedExemptions,
    overall: null,
    categories: null,
    reasons: [],
    error: null,
    latencyMs: null,
  };
}

export function erroredFileJudgement(path: string, message: string, baselineEntry: BaselineEntry | undefined): FileJudgement {
  return {
    path,
    status: 'error',
    baselineStatus: baselineEntry ? 'modified' : 'new',
    verdict: 'pass',
    blocking: false,
    needsHumanSignOff: false,
    exclusionReason: null,
    exemptCategories: [],
    matchedExemptions: [],
    overall: null,
    categories: null,
    reasons: [],
    error: message,
    latencyMs: null,
  };
}

export interface GateReport {
  schemaVersion: 1;
  generatedAt: string;
  mode: GateConfig['mode'];
  enforce: GateConfig['enforce'];
  status: 'pass' | 'fail' | 'skipped' | 'error';
  exitCode: number;
  skippedReason: string | null;
  base: { requested: string; resolvedRef: string | null; mergeBase: string | null } | null;
  provider: string | null;
  model: string | null;
  config: { path: string; gatedCategories: JevCategory[]; advisoryCategories: JevCategory[] };
  baseline: { path: string; entryCount: number; generatedAt: string | null };
  counts: {
    changed: number;
    excluded: number;
    scored: number;
    errored: number;
    pass: number;
    warn: number;
    fail: number;
    blocking: number;
    needsHumanSignOff: number;
    ratchetRegressions: number;
  };
  truncated: boolean;
  unscored: string[];
  usage: { calls: number; costUsd: number; inputTokens: number; totalLatencyMs: number };
  files: FileJudgement[];
}

export function decideExitCode(args: {
  mode: GateConfig['mode'];
  status: GateReport['status'];
  onInfrastructureError: GateConfig['onInfrastructureError'];
  files: FileJudgement[];
}): number {
  if (args.mode === 'advisory') return 0;
  if ((args.status === 'skipped' || args.status === 'error') && args.onInfrastructureError === 'fail') return 1;
  if (args.files.some((file) => file.blocking)) return 1;
  return 0;
}

function fileHasRatchetRegression(file: FileJudgement): boolean {
  if (file.status !== 'scored' || !file.categories || !file.overall) return false;
  return JEV_CATEGORIES.some((category) => file.categories![category].ratchetFail) || file.overall.ratchetFail;
}

function comparePaths(a: FileJudgement, b: FileJudgement): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function buildReport(args: {
  config: GateConfig;
  configPath: string;
  mode: GateConfig['mode'];
  baseline: Baseline;
  baselinePath: string;
  base: { requested: string; resolvedRef: string | null; mergeBase: string | null } | null;
  scorerInfo: { provider: string; model: string } | null;
  files: FileJudgement[];
  truncated: boolean;
  unscored: string[];
  usage: { calls: number; costUsd: number; inputTokens: number; totalLatencyMs: number };
  status: 'pass' | 'fail' | 'skipped' | 'error';
  skippedReason: string | null;
  now: () => Date;
}): GateReport {
  const files = [...args.files].sort(comparePaths);

  const counts = {
    changed: files.length,
    excluded: files.filter((file) => file.status === 'excluded').length,
    scored: files.filter((file) => file.status === 'scored').length,
    errored: files.filter((file) => file.status === 'error').length,
    pass: files.filter((file) => file.status === 'scored' && file.verdict === 'pass').length,
    warn: files.filter((file) => file.status === 'scored' && file.verdict === 'warn').length,
    fail: files.filter((file) => file.status === 'scored' && file.verdict === 'fail').length,
    blocking: files.filter((file) => file.blocking).length,
    needsHumanSignOff: files.filter((file) => file.needsHumanSignOff).length,
    ratchetRegressions: files.filter(fileHasRatchetRegression).length,
  };

  const exitCode = decideExitCode({
    mode: args.mode,
    status: args.status,
    onInfrastructureError: args.config.onInfrastructureError,
    files,
  });

  return {
    schemaVersion: 1,
    generatedAt: args.now().toISOString(),
    mode: args.mode,
    enforce: args.config.enforce,
    status: args.status,
    exitCode,
    skippedReason: args.skippedReason,
    base: args.base,
    provider: args.scorerInfo?.provider ?? null,
    model: args.scorerInfo?.model ?? null,
    config: {
      path: args.configPath,
      gatedCategories: args.config.gatedCategories,
      advisoryCategories: advisoryCategoriesOf(args.config),
    },
    baseline: {
      path: args.baselinePath,
      entryCount: Object.keys(args.baseline.files).length,
      generatedAt: args.baseline.generatedAt,
    },
    counts,
    truncated: args.truncated,
    unscored: args.unscored,
    usage: args.usage,
    files,
  };
}
