import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { resolvePrices, isModelPriced } from './domain/pricing.js';

export const HARNESS_IDS = ['claude', 'codex', 'copilot'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const ISOLATION_MODES = ['direct', 'worktree'] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

export const PRIORITIES = ['high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const MERGE_FATES = ['auto-merge', 'open-PR', 'artifact'] as const;
export type MergeFate = (typeof MERGE_FATES)[number];

/** The default Drive Prompt template. Placeholders: `{skill}`, `{ref}`, `{url}`; `{title}`/`{body}` are also supported. */
export const DEFAULT_DRIVE_PROMPT = `{skill}

Resolve tracker issue #{ref} ({url}) autonomously, end to end — read the issue yourself for the details. Work only on the branch you start on; Harmonic owns branching and closes the ticket once it verifies your work, so don't create branches or close the ticket yourself. When the work is done, comment a summary on the issue and call \`finish_task\`.`;

/** The default Unattended Reminder, appended to every auto-driven prompt; `{taskId}` is filled per Task. */
export const UNATTENDED_REMINDER = `## Running unattended

You are Harmonic Task {taskId} — no human is watching this turn. Ending a turn is a checkpoint, not a handoff, and Harmonic re-prompts you only a limited number of times, so don't idle-wait on background work (CI, watchers) or input. Keep working until the task is genuinely done, then call \`finish_task\` (taskId={taskId}). If you're blocked on a decision only a human can make, call \`escalate_task\` (taskId={taskId}) with a reason instead of guessing or waiting.`;

/** The default Continue Prompt, sent when an auto-driven Attempt ends its turn without a finish/escalate signal; `{taskId}` is filled per Task. */
export const DEFAULT_CONTINUE_PROMPT = `Your last turn ended but Task {taskId} isn't finished — you haven't called \`finish_task\`. Pick the work back up and drive it to completion now; don't idle-wait, then call \`finish_task\` when it's done.`;

/** The default Task Prompt template for a native Attempt. Placeholders: `{prompt}`, `{id}`, `{workingDir}`, `{harness}`, `{model}`. */
export const DEFAULT_TASK_PROMPT = `{prompt}`;

export const harnessConfigSchema = z.object({
  /** Command + args spawned to speak ACP on stdio. */
  command: z.string().meta({ example: 'npx' }),
  args: z.array(z.string()).default([]).meta({ example: ['@zed-industries/claude-code-acp'] }),
  /** Extra environment for the spawned process (e.g. API keys). */
  env: z
    .record(z.string(), z.string())
    .default({})
    .meta({ example: { ANTHROPIC_API_KEY: '<your-api-key>' } }),
  models: z.array(z.string()).default([]).meta({ example: ['sonnet-5', 'opus-4.8'] }),
  defaultModel: z.string().meta({ example: 'sonnet-5' }),
  /**
   * Root of the harness's native session logs, for the per-model usage
   * fallback (Claude Code: ~/.claude/projects). Empty string disables.
   */
  sessionLogDir: z.string().optional().meta({ example: '~/.claude/projects' }),
});

/** Per-model API rates in $/Mtok; must match `ModelPrice` in domain/pricing.ts. */
export const modelPriceSchema = z.object({
  input: z.number().nonnegative().meta({ example: 3 }),
  output: z.number().nonnegative().meta({ example: 15 }),
  cacheRead: z.number().nonnegative().meta({ example: 0.3 }),
  cacheWrite: z.number().nonnegative().meta({ example: 3.75 }),
});

/** Optional per-model facts for Conversation telemetry; without a window, context usage degrades to raw token counts, and without a TTL the cold-cache warning is suppressed. */
export const modelInfoSchema = z.object({
  /** Total context window in tokens, for the context-usage percentage. */
  contextWindow: z.number().int().positive().optional().meta({ example: 200000 }),
  /** Prompt-cache TTL in seconds, for the idle cold-cache warning. */
  cacheTtlSeconds: z.number().int().positive().optional().meta({ example: 300 }),
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
  config: Pick<AppConfig, 'harnesses' | 'prices' | 'verify'>,
): string[] {
  if (budget.costUsd == null || budget.tokens != null) return [];
  const prices = resolvePrices(config.prices);
  const configured = new Set<string>();
  for (const harness of Object.values(config.harnesses)) {
    for (const m of harness.models) configured.add(m);
    configured.add(harness.defaultModel);
  }
  if (config.verify.review.enabled && config.verify.review.model) configured.add(config.verify.review.model);
  return [...configured].filter((m) => !isModelPriced(m, prices));
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
  name: z.string().default('').meta({ example: 'Production' }),
  harnesses: z.record(z.enum(HARNESS_IDS), harnessConfigSchema).meta({
    example: {
      claude: {
        command: 'npx',
        args: ['@zed-industries/claude-code-acp'],
        env: {},
        models: ['sonnet-5', 'opus-4.8'],
        defaultModel: 'sonnet-5',
      },
    },
  }),
  /**
   * Price-table overrides for Cost: entries here override or extend the
   * shipped `DEFAULT_PRICES` (domain/pricing.ts).
   */
  prices: z
    .record(z.string(), modelPriceSchema)
    .default({})
    .meta({ example: { 'sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } }),
  /** Optional per-model context-window / cache-TTL facts for Conversation telemetry. */
  modelInfo: z
    .record(z.string(), modelInfoSchema)
    .default({})
    .meta({ example: { 'sonnet-5': { contextWindow: 200000, cacheTtlSeconds: 300 } } }),
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
  maxAttempts: z.number().int().min(1).default(2).meta({ example: 2 }),
  /** Reuse a warm Session into Attempt N+1 while its context occupancy stays
   * below this many tokens; at or above it, start a condensed new Session. A raw
   * token count (not a fraction), so it is independent of the model's window. */
  contextReuseTokenLimit: z.number().int().min(0).default(200_000).meta({ example: 200_000 }),
  /**
   * `prompt` is the global Drive Prompt template; `unattendedReminder` is appended to every auto-driven turn;
   * `continuePrompt` is the re-prompt nudge; `mergeFate` is the default fate of a completed worktree branch
   * (research Tasks are always artifacts); `continueAttempts` is how many re-prompts an Attempt gets before it
   * is verified as-is (0 = single turn).
   */
  drive: z
    .object({
      prompt: z.string().default(DEFAULT_DRIVE_PROMPT).meta({ example: DEFAULT_DRIVE_PROMPT }),
      unattendedReminder: z.string().default(UNATTENDED_REMINDER).meta({ example: UNATTENDED_REMINDER }),
      continuePrompt: z.string().default(DEFAULT_CONTINUE_PROMPT).meta({ example: DEFAULT_CONTINUE_PROMPT }),
      mergeFate: z.enum(MERGE_FATES).default('auto-merge').meta({ example: 'auto-merge' }),
      continueAttempts: z.number().int().min(0).default(10).meta({ example: 10 }),
    })
    .prefault({}),
  /** Operator-editable wrapper around a native Task's prompt (`{prompt}`, `{id}`, `{workingDir}`, `{harness}`, `{model}`); defaults to bare `{prompt}`. */
  taskPrompt: z.string().default(DEFAULT_TASK_PROMPT).meta({ example: DEFAULT_TASK_PROMPT }),
  /** End a Conversation with no Turn for this many minutes; 0 disables. Fractional values are allowed. */
  conversationIdleTimeoutMinutes: z.number().nonnegative().default(30).meta({ example: 30 }),
  /** Ordered verification contract. Commands fail fast; review runs last. */
  verify: z
    .object({
      commands: z.array(verificationCommandSchema).default([]),
      review: verificationReviewSchema.prefault({}),
    })
    .prefault({}),
  /** `postMergeCheck` runs the verification commands on the merged base tip; the off-switch for slow suites. */
  merge: z
    .object({
      postMergeCheck: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * `budget` = the wall-clock/token/cost caps; `progress` toggles the stall/loop detector;
   * `toolTimeoutMinutes` bounds any single tool call (the stall detector suspends itself while one is outstanding);
   * `promptInactivityTimeoutMinutes` bounds an ACP prompt turn by silence, suspended while a tool call is outstanding, always on.
   */
  guardrails: z
    .object({
      budget: budgetGuardrailSchema.prefault({}),
      progress: z.boolean().default(false),
      toolTimeoutMinutes: z.number().positive().default(20),
      promptInactivityTimeoutMinutes: z.number().positive().default(15),
    })
    .prefault({}),
}).superRefine((config, ctx) => {
  for (const [id, harness] of Object.entries(config.harnesses)) {
    if (harness.models.length > 0 && !harness.models.includes(harness.defaultModel)) {
      ctx.addIssue({
        code: 'custom',
        path: ['harnesses', id, 'defaultModel'],
        message: `defaultModel must be one of the harness's models`,
      });
    }
  }
  const chatHarness = config.harnesses[config.chat.harness];
  if (chatHarness && chatHarness.models.length > 0 && !chatHarness.models.includes(config.chat.model)) {
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

export function defaultConfig(): AppConfig {
  return {
    name: '',
    harnesses: {
      claude: {
        command: 'npx',
        args: ['--yes', '@agentclientprotocol/claude-agent-acp'],
        env: {},
        models: ['claude-opus-5', 'claude-fable-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
        defaultModel: 'claude-sonnet-5',
      },
      codex: {
        // `codex acp` is not a Codex CLI subcommand; the adapter package is the ACP entry point.
        command: 'npx',
        args: ['--yes', '@agentclientprotocol/codex-acp'],
        env: {},
        // Ids may carry a reasoning-effort suffix, e.g. gpt-5.4-mini[low].
        models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
        defaultModel: 'gpt-5.6-sol',
      },
      copilot: {
        // `copilot --acp` speaks ACP natively; the built-in github-mcp-server is a per-session network dependency Attempts don't need.
        command: 'copilot',
        args: ['--acp', '--disable-builtin-mcps'],
        env: {},
        // Only ids with a published API-equivalent rate (gemini-*/mai-* excluded); auto-only plans silently ignore any pin.
        models: [
          'auto',
          'claude-sonnet-5',
          'claude-sonnet-4.6',
          'claude-sonnet-4.5',
          'claude-haiku-4.5',
          'claude-opus-4.8',
          'claude-opus-4.7',
          'claude-opus-4.6',
          'claude-opus-4.5',
          'gpt-5.5',
          'gpt-5.4',
          'gpt-5.3-codex',
          'gpt-5.4-mini',
          'gpt-5.6-luna',
          'gpt-5.6-terra',
        ],
        defaultModel: 'auto',
      },
    },
    prices: {},
    modelInfo: {},
    defaults: {
      harness: 'claude',
      workingDir: process.cwd(),
      isolationMode: 'direct',
      priority: 'normal',
      conflictResolveTurns: 2,
    },
    chat: {
      harness: 'claude',
      model: 'claude-sonnet-5',
    },
    autoRunner: {
      enabled: false,
      maxConcurrentAttempts: 1,
    },
    maxAttempts: 2,
    contextReuseTokenLimit: 200_000,
    drive: {
      prompt: DEFAULT_DRIVE_PROMPT,
      unattendedReminder: UNATTENDED_REMINDER,
      continuePrompt: DEFAULT_CONTINUE_PROMPT,
      mergeFate: 'auto-merge',
      continueAttempts: 10,
    },
    taskPrompt: DEFAULT_TASK_PROMPT,
    conversationIdleTimeoutMinutes: 30,
    verify: {
      commands: [],
      review: { enabled: false },
    },
    merge: { postMergeCheck: true },
    guardrails: {
      budget: { wallClockMinutes: 60, tokens: null, costUsd: null },
      progress: false,
      toolTimeoutMinutes: 20,
      promptInactivityTimeoutMinutes: 15,
    },
  };
}

export function mergeConfig(base: AppConfig, overrides?: DeepPartial<AppConfig>): AppConfig {
  if (!overrides) return base;
  const merge = (a: any, b: any): any => {
    if (b === undefined) return a;
    if (b === null || typeof b !== 'object' || Array.isArray(b)) return b;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) return b;
    const out: any = { ...a };
    for (const key of Object.keys(b)) out[key] = merge(a[key], b[key]);
    return out;
  };
  return appConfigSchema.parse(merge(base, overrides));
}

export function defaultDataDir(): string {
  return process.env.HARMONIC_DATA_DIR ?? join(homedir(), '.harmonic');
}
