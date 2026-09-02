import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { isModelPriced, pricesForHarness } from './domain/pricing.js';

export const HARNESS_IDS = ['claude', 'codex', 'copilot'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const ISOLATION_MODES = ['direct', 'worktree'] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

export const PRIORITIES = ['high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const MERGE_FATES = ['auto-merge', 'open-PR', 'artifact'] as const;
export type MergeFate = (typeof MERGE_FATES)[number];

export const modelPriceSchema = z.object({
  input: z.number().nonnegative().meta({ example: 3 }),
  output: z.number().nonnegative().meta({ example: 15 }),
  cacheRead: z.number().nonnegative().meta({ example: 0.3 }),
  cacheWrite: z.number().nonnegative().meta({ example: 3.75 }),
});

export const modelCatalogEntrySchema = z.object({
  id: z.string().min(1).meta({ example: 'sonnet-5' }),
  price: modelPriceSchema.optional(),
  contextWindow: z.number().int().positive().optional().meta({ example: 200000 }),
});

export const harnessConfigSchema = z.object({
  /** Command + args spawned to speak ACP on stdio. */
  command: z.string().meta({ example: 'npx' }),
  args: z.array(z.string()).meta({ example: ['@zed-industries/claude-code-acp'] }),
  /** Extra environment for the spawned process (e.g. API keys). */
  env: z
    .record(z.string(), z.string())
    .meta({ example: { ANTHROPIC_API_KEY: '<your-api-key>' } }),
  models: z.array(modelCatalogEntrySchema).superRefine((models, ctx) => {
    const seen = new Set<string>();
    for (const [index, model] of models.entries()) {
      if (seen.has(model.id)) {
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'model ids must be unique within a harness' });
      }
      seen.add(model.id);
    }
  }).meta({ example: [{ id: 'sonnet-5' }, { id: 'opus-4.8' }] }),
  defaultModel: z.string().meta({ example: 'sonnet-5' }),
  cacheWarmSeconds: z.number().int().positive().meta({ example: 300 }),
  /**
   * Root of the harness's native session logs, for the per-model usage
   * fallback (Claude Code: ~/.claude/projects). Empty string disables.
   */
  sessionLogDir: z.string().optional().meta({ example: '~/.claude/projects' }),
});


/**
 * A command verifier: an argv-based check (a Workspace's test/lint) run against
 * a frozen candidate in a disposable checkout.
 */
export const verificationCommandSchema = z.object({
  /** The executable to spawn (argv[0]); args are passed separately, never a shell string. */
  command: z.string().min(1).meta({ example: 'npm' }),
  args: z.array(z.string()).default([]).meta({ example: ['test'] }),
  /** Working directory, relative to the checkout root; omitted runs at the root. */
  cwd: z.string().optional().meta({ example: 'packages/api' }),
  env: z.record(z.string(), z.string()).default({}).meta({ example: { CI: '1' } }),
  /** Hard timeout in seconds; a command that overruns is killed and reads inconclusive. */
  timeoutSeconds: z.number().int().positive().default(600).meta({ example: 600 }),
});
export type VerificationCommand = z.infer<typeof verificationCommandSchema>;

/**
 * An agent critic verifier: a read-only reviewer Harness with its own prompt and
 * model that judges the candidate diff.
 */
export const verificationCriticSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .meta({ example: 'Review the change against issue {ref}: {title}. Read the code and the issue to decide.' }),
  model: z.string().min(1).meta({ example: 'claude-opus-5' }),
  /** Reviewer harness; omitted = reuse the builder task's harness. */
  harness: z.enum(HARNESS_IDS).optional().meta({ example: 'claude' }),
});
export type VerificationCritic = z.infer<typeof verificationCriticSchema>;

/** The one optional review step that follows the ordered command list. */
export const verificationReviewSchema = z
  .object({
    enabled: z.boolean().default(false),
    prompt: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    harness: z.enum(HARNESS_IDS).optional(),
  })
  .superRefine((review, ctx) => {
    if (!review.enabled) return;
    if (!review.prompt) ctx.addIssue({ code: 'custom', path: ['prompt'], message: 'prompt is required when review is enabled' });
    if (!review.model) ctx.addIssue({ code: 'custom', path: ['model'], message: 'model is required when review is enabled' });
  });
export type VerificationReview = z.infer<typeof verificationReviewSchema>;

/** List-grain override: `null`/absent inherits the global list, a non-empty array replaces it, an empty array runs no commands. */
export const verificationCommandOverrideSchema = z.array(verificationCommandSchema);

/** Wall-clock is mandatory; tokens and cost are opt-in (null = unset). The effective config is snapshotted onto an Attempt at start. */
export const budgetGuardrailSchema = z.object({
  /** Mandatory wall-clock bound in minutes, scoped to execution/validation/verification. */
  wallClockMinutes: z.number().positive().default(60).meta({ example: 60 }),
  /** Optional cumulative token cap; null = no token limit. */
  tokens: z.number().int().positive().nullable().default(null).meta({ example: 2000000 }),
  /** Optional cost cap in USD; null = no cost limit. Falls back to `tokens` where a model is unpriced. */
  costUsd: z.number().positive().nullable().default(null).meta({ example: 10 }),
});
export type BudgetGuardrail = z.infer<typeof budgetGuardrailSchema>;

/** The configured models a cost cap can't measure: a cost cap with no token fallback needs every model priced. Empty when the cap is measurable. */
export function unpricedModelsForCostCap(
  budget: Pick<BudgetGuardrail, 'costUsd' | 'tokens'>,
  config: Pick<AppConfig, 'harnesses' | 'verify' | 'defaults'>,
): string[] {
  if (budget.costUsd == null || budget.tokens != null) return [];
  const configured = new Set<string>();
  for (const [harnessId, harness] of Object.entries(config.harnesses)) {
    const prices = pricesForHarness(harness);
    for (const m of harness.models) if (!isModelPriced(m.id, prices)) configured.add(`${harnessId}/${m.id}`);
    if (!isModelPriced(harness.defaultModel, prices)) configured.add(`${harnessId}/${harness.defaultModel}`);
  }
  if (config.verify.review.enabled && config.verify.review.model) {
    const harness = config.harnesses[config.verify.review.harness ?? config.defaults.harness];
    if (harness && !isModelPriced(config.verify.review.model, pricesForHarness(harness))) configured.add(`${config.verify.review.harness ?? config.defaults.harness}/${config.verify.review.model}`);
  }
  return [...configured];
}

/** Must stay free of `'; '`: the API error handler and the settings form's `parseFieldErrors` split `path: message` pairs on it. */
export function costCapMessage(unpriced: string[]): string {
  return `a cost cap with no token fallback requires every configured model to be priced — unpriced: ${unpriced.join(', ')}`;
}

/** True when neither the command verifier nor critic review is configured, so candidates would merge unverified. */
export function verifyChannelsUnconfigured(verify: Pick<AppConfig, 'verify'>['verify']): boolean {
  return verify.commands.length === 0 && !verify.review.enabled;
}

export const appConfigSchema = z.object({
  /** Operator-chosen display name; feeds the sidebar heading and browser title. Empty (the default) falls back to "Harmonic". */
  name: z.string().meta({ example: 'Production' }),
  harnesses: z.record(z.enum(HARNESS_IDS), harnessConfigSchema).meta({
    example: {
      claude: {
        command: 'npx',
        args: ['@zed-industries/claude-code-acp'],
        env: {},
        models: [{ id: 'sonnet-5' }, { id: 'opus-4.8' }],
        defaultModel: 'sonnet-5',
        cacheWarmSeconds: 300,
      },
    },
  }),
  defaults: z.object({
    harness: z.enum(HARNESS_IDS).meta({ example: 'claude' }),
    workingDir: z.string().meta({ example: '/home/dev/harmonic' }),
    isolationMode: z.enum(ISOLATION_MODES).meta({ example: 'worktree' }),
    priority: z.enum(PRIORITIES).meta({ example: 'normal' }),
    /** Agentic resolve-turns a rebase conflict gets before it escalates; 0 escalates on the first conflict. */
    conflictResolveTurns: z.number().int().min(0).meta({ example: 2 }),
  }),
  /** The default Harness and model a new Conversation starts with; a Workspace stores `null` to inherit. */
  chat: z.object({
    harness: z.enum(HARNESS_IDS).meta({ example: 'claude' }),
    model: z.string().meta({ example: 'claude-sonnet-5' }),
  }),
  /** `enabled` is the fleet-wide master switch gating every Workspace; `maxConcurrentAttempts` is the Machine Ceiling a per-Workspace cap can never exceed. */
  autoRunner: z.object({
    enabled: z.boolean().meta({ example: true }),
    maxConcurrentAttempts: z.number().int().min(1).meta({ example: 3 }),
  }),
  /** Maximum failed implementation attempts before the ticket is escalated. */
  maxAttempts: z.number().int().min(1).meta({ example: 2 }),
  /** Reuse a warm Session into Attempt N+1 while its context occupancy stays
   * below this many tokens; at or above it, start a condensed new Session. A raw
   * token count (not a fraction), so it is independent of the model's window. */
  contextReuseTokenLimit: z.number().int().min(0).meta({ example: 200_000 }),
  /**
   * `prompt` is the global Drive Prompt template; `unattendedReminder` is appended to every auto-driven turn;
   * `continuePrompt` is the re-prompt nudge; `mergeFate` is the default fate of a completed worktree branch
   * (research Tasks are always artifacts); `continueAttempts` is how many re-prompts an Attempt gets before it
   * is verified as-is (0 = single turn).
   */
  drive: z.object({
    prompt: z.string().meta({ example: 'Resolve tracker issue #{ref} ({url}).' }),
    unattendedReminder: z.string().meta({ example: 'Task {taskId} is running unattended.' }),
    continuePrompt: z.string().meta({ example: 'Continue Task {taskId}.' }),
    mergeFate: z.enum(MERGE_FATES).meta({ example: 'auto-merge' }),
    continueAttempts: z.number().int().min(0).meta({ example: 10 }),
  }),
  /** Operator-editable wrapper around a native Task's prompt (`{prompt}`, `{id}`, `{workingDir}`, `{harness}`, `{model}`); defaults to bare `{prompt}`. */
  taskPrompt: z.string().meta({ example: 'Work on {prompt}.' }),
  /** End a Conversation with no Turn for this many minutes; 0 disables. Fractional values are allowed. */
  conversationIdleTimeoutMinutes: z.number().nonnegative().meta({ example: 30 }),
  /** Ordered verification contract. Commands fail fast; review runs last. */
  verify: z.object({
    commands: z.array(verificationCommandSchema),
    review: verificationReviewSchema,
  }),
  /** `postMergeCheck` runs the verification commands on the merged base tip; the off-switch for slow suites. */
  merge: z.object({
    postMergeCheck: z.boolean(),
  }),
  /**
   * `budget` = the wall-clock/token/cost caps; `progress` toggles the stall/loop detector;
   * `toolTimeoutMinutes` bounds any single tool call (the stall detector suspends itself while one is outstanding);
   * `promptInactivityTimeoutMinutes` bounds an ACP prompt turn by silence, suspended while a tool call is outstanding, always on.
   */
  guardrails: z.object({
    budget: budgetGuardrailSchema,
    progress: z.boolean(),
    toolTimeoutMinutes: z.number().positive(),
    promptInactivityTimeoutMinutes: z.number().positive(),
  }),
}).superRefine((config, ctx) => {
  for (const [id, harness] of Object.entries(config.harnesses)) {
    if (harness.models.length > 0 && !harness.models.some((model) => model.id === harness.defaultModel)) {
      ctx.addIssue({
        code: 'custom',
        path: ['harnesses', id, 'defaultModel'],
        message: `defaultModel must be one of the harness's models`,
      });
    }
  }
  const chatHarness = config.harnesses[config.chat.harness];
  if (chatHarness && chatHarness.models.length > 0 && !chatHarness.models.some((model) => model.id === config.chat.model)) {
    ctx.addIssue({
      code: 'custom',
      path: ['chat', 'model'],
      message: `chat model must be one of the ${config.chat.harness} harness's models`,
    });
  }
  const unpriced = unpricedModelsForCostCap(config.guardrails.budget, config);
  if (unpriced.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['guardrails', 'budget', 'costUsd'],
      message: costCapMessage(unpriced),
    });
  }
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type HarnessConfig = z.infer<typeof harnessConfigSchema>;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

const baselinePath = fileURLToPath(new URL('./baseline.yaml', import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveBaselineVariables(value: unknown): unknown {
  if (value === '$CWD') return process.cwd();
  if (Array.isArray(value)) return value.map(resolveBaselineVariables);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveBaselineVariables(entry)]));
}

function missingBaselineFields(raw: unknown, resolved: unknown, path = ''): string[] {
  if (Array.isArray(resolved)) return Array.isArray(raw) ? [] : [path];
  if (!isRecord(resolved)) return [];
  if (!isRecord(raw)) return [path || '<root>'];
  return Object.entries(resolved).flatMap(([key, value]) => {
    const fieldPath = path ? `${path}.${key}` : key;
    if (!(key in raw)) return [fieldPath];
    return missingBaselineFields(raw[key], value, fieldPath);
  });
}

export function loadBaselineConfig(path: string = baselinePath): AppConfig {
  let raw: unknown;
  try {
    raw = resolveBaselineVariables(parse(readFileSync(path, 'utf8')));
  } catch (err) {
    throw new Error(`Invalid Harmonic baseline file at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const config = appConfigSchema.parse(raw);
    const missing = missingBaselineFields(raw, config);
    if (missing.length > 0) throw new Error(`missing required defaults: ${missing.join(', ')}`);
    return config;
  } catch (err) {
    throw new Error(`Invalid Harmonic baseline file at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const baseline = loadBaselineConfig();

export const AUTO_MODEL_SENTINEL = baseline.harnesses.copilot.defaultModel;
export const DEFAULT_DRIVE_PROMPT = baseline.drive.prompt;
export const UNATTENDED_REMINDER = baseline.drive.unattendedReminder;
export const DEFAULT_CONTINUE_PROMPT = baseline.drive.continuePrompt;
export const DEFAULT_TASK_PROMPT = baseline.taskPrompt;

export function baselineConfig(): AppConfig {
  return structuredClone(baseline);
}

function migrateLegacyModelCatalogs(base: AppConfig, overrides: unknown): unknown {
  if (!isRecord(overrides)) return overrides;
  const migrated = structuredClone(overrides);
  const prices = isRecord(migrated.prices) ? migrated.prices : {};
  const modelInfo = isRecord(migrated.modelInfo) ? migrated.modelInfo : {};
  const legacyModelIds = new Set([...Object.keys(prices), ...Object.keys(modelInfo)]);
  const hasLegacyCatalogData = legacyModelIds.size > 0;
  const harnesses = isRecord(migrated.harnesses) ? migrated.harnesses : {};

  for (const [id, baseHarness] of Object.entries(base.harnesses)) {
    const override = harnesses[id];
    if (override !== undefined && !isRecord(override)) continue;
    const overrideModels: unknown[] | undefined = Array.isArray(override?.models) ? override.models : undefined;
    const hasOverrideModels = overrideModels !== undefined;
    const models: readonly unknown[] = overrideModels ?? baseHarness.models;
    const catalog = models.map((model) => {
      const entry = typeof model === 'string' ? { id: model } : model;
      if (!isRecord(entry) || typeof entry.id !== 'string') return entry;
      const modelInfoEntry = modelInfo[entry.id];
      const info = isRecord(modelInfoEntry) ? modelInfoEntry : {};
      return {
        ...entry,
        ...((!hasOverrideModels || entry.price === undefined) && isRecord(prices[entry.id]) ? { price: prices[entry.id] } : {}),
        ...((!hasOverrideModels || entry.contextWindow === undefined) && typeof info.contextWindow === 'number' ? { contextWindow: info.contextWindow } : {}),
      };
    });
    if (hasLegacyCatalogData) {
      for (const modelId of legacyModelIds) {
        if (catalog.some((entry) => isRecord(entry) && entry.id === modelId)) continue;
        const modelInfoEntry = modelInfo[modelId];
        const info = isRecord(modelInfoEntry) ? modelInfoEntry : {};
        catalog.push({
          id: modelId,
          ...(isRecord(prices[modelId]) ? { price: prices[modelId] } : {}),
          ...(typeof info.contextWindow === 'number' ? { contextWindow: info.contextWindow } : {}),
        });
      }
    }
    const needsMigration = models.some((model) => typeof model === 'string')
      || (hasLegacyCatalogData && catalog.some((model, index) => model !== models[index]));
    if (needsMigration) harnesses[id] = { ...override, models: catalog };
  }
  if (Object.keys(harnesses).length > 0) migrated.harnesses = harnesses;
  delete migrated.prices;
  delete migrated.modelInfo;
  return migrated;
}

export function mergeConfig(base: AppConfig, overrides?: DeepPartial<AppConfig>): AppConfig {
  if (!overrides) return base;
  const merge = (a: any, b: any, path: readonly string[] = []): any => {
    if (b === undefined) return a;
    if (isModelCatalogPath(path) && Array.isArray(a) && isRecord(b)) {
      return mergeModelCatalog(a, b);
    }
    if (b === null || typeof b !== 'object' || Array.isArray(b)) return b;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) return b;
    const out: any = { ...a };
    for (const key of Object.keys(b)) out[key] = merge(a[key], b[key], [...path, key]);
    return out;
  };
  return appConfigSchema.parse(merge(base, migrateLegacyModelCatalogs(base, overrides)));
}

function isModelCatalogPath(path: readonly string[]): boolean {
  return path[0] === 'harnesses' && path[2] === 'models';
}

/** Apply the id-keyed patch that persists a harness model catalog. */
function mergeModelCatalog(base: unknown[], patch: Record<string, unknown>): unknown[] {
  const baseline = new Map(
    base.flatMap((model) => isRecord(model) && typeof model.id === 'string' ? [[model.id, model] as const] : []),
  );
  const merged = base.flatMap((model) => {
    if (!isRecord(model) || typeof model.id !== 'string') return [model];
    const change = patch[model.id];
    if (change === null) return [];
    return [isRecord(change) ? mergeModelEntry(model, change, model.id) : model];
  });
  for (const [id, change] of Object.entries(patch)) {
    if (baseline.has(id) || change === null || !isRecord(change)) continue;
    merged.push(mergeModelEntry({}, change, id));
  }
  return merged;
}

function mergeModelEntry(base: Record<string, unknown>, patch: Record<string, unknown>, id: string): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, id };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id') continue;
    if (value === null) {
      delete merged[key];
    } else if (isRecord(value) && isRecord(merged[key])) {
      const nested = mergeModelEntry(merged[key], value, '');
      delete nested.id;
      merged[key] = nested;
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function defaultDataDir(): string {
  return process.env.HARMONIC_DATA_DIR ?? join(homedir(), '.harmonic');
}
