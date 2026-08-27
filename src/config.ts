import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { resolvePrices, isModelPriced } from './execution/pricing.js';

export const HARNESS_IDS = ['claude', 'codex', 'copilot'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const ISOLATION_MODES = ['direct', 'worktree'] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

export const PRIORITIES = ['high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const MERGE_FATES = ['auto-merge', 'open-PR', 'artifact'] as const;
export type MergeFate = (typeof MERGE_FATES)[number];

/**
 * The default Drive Prompt template (issue #33). Placeholders `{skill}` (from
 * the Task's Workflow / Wayfinder Type), `{ref}`, `{url}` are filled from the
 * mirrored Task. `{title}`/`{body}` are still supported for operators who want
 * to inline the ticket text, but the default omits them — the agent fetches
 * the issue itself, so the skill stays the source of truth and Harmonic only
 * points at the ticket and states its contract (fetch → resolve → finish_task).
 */
export const DEFAULT_DRIVE_PROMPT = `{skill}

Resolve tracker issue #{ref} ({url}) autonomously, end to end — read the issue yourself for the details. Work only on the branch you start on; Harmonic owns branching and closes the ticket once it verifies your work, so don't create branches or close the ticket yourself. When the work is done, comment a summary on the issue and call \`finish_task\`.`;

/**
 * The default Unattended Reminder, appended to every auto-driven prompt (initial
 * and continue) by `AutoDrive.prompt`/`continuePrompt`. Operator-editable via
 * `config.drive.unattendedReminder`. Harmonic settles a run when the prompt turn
 * resolves, so an agent that ends its turn to idle-wait used to look "done".
 * This tells the agent the turn boundary is a checkpoint, not an exit, and gives
 * it the two signals the Runner reads — `finish_task` and `escalate_task` — with
 * its Harmonic Task id filled into `{taskId}`. The don't-close-the-ticket rule
 * lives in the Drive Prompt; it is not repeated here.
 */
export const UNATTENDED_REMINDER = `## Running unattended

You are Harmonic Task {taskId} — no human is watching this turn. Ending a turn is a checkpoint, not a handoff, and Harmonic re-prompts you only a limited number of times, so don't idle-wait on background work (CI, watchers) or input. Keep working until the task is genuinely done, then call \`finish_task\` (taskId={taskId}). If you're blocked on a decision only a human can make, call \`escalate_task\` (taskId={taskId}) with a reason instead of guessing or waiting.`;

/**
 * The default Continue Prompt, sent when an auto-driven Run ends its turn
 * without a finish/escalate signal (`AutoDrive.continuePrompt`). Operator-editable
 * via `config.drive.continuePrompt`. The Unattended Reminder is appended after
 * it, so this carries only the "pick it back up" nudge. `{taskId}` is filled
 * per Task.
 */
export const DEFAULT_CONTINUE_PROMPT = `Your last turn ended but Task {taskId} isn't finished — you haven't called \`finish_task\`. Pick the work back up and drive it to completion now; don't idle-wait, then call \`finish_task\` when it's done.`;

/**
 * The default Task Prompt template for a **native** (non-mirrored) Run. The
 * bare `{prompt}` preserves the pre-template behaviour exactly — the Task's own
 * prompt is sent verbatim. Operators can wrap it (a house preamble, a "when
 * done" coda) using the placeholders `{prompt}` (the Task's prompt), `{id}`,
 * `{workingDir}`, `{harness}`, `{model}`. Mirrored Tasks ignore this and use
 * the Drive Prompt instead (auto-drive.ts).
 */
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

/** Per-model API rates in $/Mtok; must match `ModelPrice` in execution/pricing.ts. */
export const modelPriceSchema = z.object({
  input: z.number().nonnegative().meta({ example: 3 }),
  output: z.number().nonnegative().meta({ example: 15 }),
  cacheRead: z.number().nonnegative().meta({ example: 0.3 }),
  cacheWrite: z.number().nonnegative().meta({ example: 3.75 }),
});

/**
 * Optional per-model facts for Conversation telemetry (issue 12). Both
 * optional: with no window, context usage degrades to raw token counts; with
 * no TTL, the cold-cache warning is suppressed — never a fake percentage or a
 * guessed staleness.
 */
export const modelInfoSchema = z.object({
  /** Total context window in tokens, for the context-usage percentage. */
  contextWindow: z.number().int().positive().optional().meta({ example: 200000 }),
  /** Prompt-cache TTL in seconds, for the idle cold-cache warning. */
  cacheTtlSeconds: z.number().int().positive().optional().meta({ example: 300 }),
});

/**
 * A command verifier (issue #132, ADR-0021): an argv-based check (a Workspace's
 * test/lint) run against a frozen candidate in a disposable checkout. Only the
 * config surface exists in #132 — nothing executes yet.
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
 * An agent critic verifier (issue #132, ADR-0021): a read-only reviewer Harness
 * with its own prompt and model that judges the candidate diff. Config surface
 * only in #132 — no critic runs yet.
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

/**
 * The sentinel a Workspace stores to force a verifier OFF for itself (issue #174),
 * distinct from inheriting the global default. At this layer `null`/absent means
 * inherit; a configured verifier object means override; `{ off: true }` means the
 * Workspace has explicitly disabled the verifier regardless of the global setting.
 */
export const verifierOffSchema = z.object({ off: z.literal(true) });
export type VerifierOff = z.infer<typeof verifierOffSchema>;
export const verificationCommandOverrideSchema = z.union([z.array(verificationCommandSchema), verificationCommandSchema, verifierOffSchema]);
// Order matters: verificationReviewSchema is permissive enough (enabled defaults
// false, prompt/model optional) to swallow a bare critic object or the off
// sentinel and coerce it to a disabled review, so the stricter members must be
// tried first — otherwise enabling the critic for a workspace persists as off.
// The critic member is matched `.strict()` so a review-shaped object (one that
// carries `enabled`) is NOT silently accepted here with `enabled` stripped —
// which would drop an explicit `enabled: false` and let `resolveReview` re-wrap
// it as enabled. Strict-rejecting the extra key lets it fall through to the
// review schema, which round-trips `enabled` faithfully.
export const verificationCriticOverrideSchema = z.union([verifierOffSchema, verificationCriticSchema.strict(), verificationReviewSchema]);

/**
 * The budget Guardrail (issue #108/#126, ADR-0019): a mandatory wall-clock bound
 * per afk Run plus optional token and cost caps. Wall-clock is never null — it
 * always guards; tokens and cost are opt-in (null = unset). All three are
 * enforced live off the Usage tailer (wall-clock #127, token/cost #128). The
 * effective config is snapshotted onto a Run at start (`RunStore.create`) so a
 * later limit change can't retroactively change whether that Run would trip.
 */
export const budgetGuardrailSchema = z.object({
  /** Mandatory wall-clock bound in minutes, scoped to execution/validation/verification. */
  wallClockMinutes: z.number().positive().default(60).meta({ example: 60 }),
  /** Optional cumulative token cap; null = no token limit. */
  tokens: z.number().int().positive().nullable().default(null).meta({ example: 2000000 }),
  /** Optional cost cap in USD; null = no cost limit. Falls back to `tokens` where a model is unpriced. */
  costUsd: z.number().positive().nullable().default(null).meta({ example: 10 }),
});
export type BudgetGuardrail = z.infer<typeof budgetGuardrailSchema>;

/**
 * The configured models a cost cap can't measure (issue #126, ADR-0019). A cost
 * cap with no token fallback needs every model a Run could bill against to be
 * priced — an unpriced model has no enforceable spend bound. Returns the empty
 * set when the cap is measurable (no cost cap, a token fallback exists, or every
 * model is priced). Shared by the global-config check and the per-Workspace
 * budget-override check (issue #166) so both reject the same invalid combination.
 */
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
  // The agent critic (#132) is another model a Run bills against — the budget is
  // phase-scoped over verifying too (ADR-0019) — so its model must be priced on
  // the same footing as a harness model.
  if (config.verify.review.enabled && config.verify.review.model) configured.add(config.verify.review.model);
  return [...configured].filter((m) => !isModelPriced(m, prices));
}

/**
 * The field message for an unmeasurable cost cap. Deliberately free of `'; '` —
 * both the API error handler and the settings form's `parseFieldErrors` split
 * `path: message` pairs on that delimiter, so a `'; '` in the body would slice
 * the unpriced-model list off into a bogus, unrendered field (issue #166).
 */
export function costCapMessage(unpriced: string[]): string {
  return `a cost cap with no token fallback requires every configured model to be priced — unpriced: ${unpriced.join(', ')}`;
}

export const appConfigSchema = z.object({
  /**
   * Operator-chosen display name for this instance (issue: instance rename).
   * Harmonic still calls itself Harmonic everywhere in prose; this only feeds
   * the sidebar heading and the browser title (`Harmonic - {name} - {workspace}`).
   * Empty string (the default) means unnamed — the UI falls back to "Harmonic".
   */
  name: z.string().default('').meta({ example: 'Production' }),
  // A record declares no shape, so the API docs fall back to printing its
  // JSON Schema unless it carries an example of its own.
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
   * shipped `DEFAULT_PRICES` (execution/pricing.ts).
   */
  prices: z
    .record(z.string(), modelPriceSchema)
    .default({})
    .meta({ example: { 'sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } }),
  /** Optional per-model context-window / cache-TTL facts for Conversation telemetry (issue 12). */
  modelInfo: z
    .record(z.string(), modelInfoSchema)
    .default({})
    .meta({ example: { 'sonnet-5': { contextWindow: 200000, cacheTtlSeconds: 300 } } }),
  defaults: z.object({
    harness: z.enum(HARNESS_IDS).meta({ example: 'claude' }),
    workingDir: z.string().meta({ example: '/home/dev/harmonic' }),
    isolationMode: z.enum(ISOLATION_MODES).meta({ example: 'worktree' }),
    priority: z.enum(PRIORITIES).meta({ example: 'normal' }),
    /** How many times a worktree Run's integration may re-read the base and
     * rebase+re-verify before it defers/escalates (ADR-0046). */
    integrationRetries: z.number().int().min(1).meta({ example: 5 }),
    /** Bounded agentic resolve-turns a rebase content conflict gets before it
     * escalates; 0 escalates on the first conflict (ADR-0046). */
    conflictResolveTurns: z.number().int().min(0).meta({ example: 2 }),
  }),
  /**
   * The default Harness and model a new Conversation ("chat") starts with,
   * separate from the Task defaults above — an operator often wants to *talk*
   * to a different agent than the one that runs the board. Global-default with
   * a per-Workspace override (ADR-0012): a Workspace stores `null` to inherit
   * these, a value to override, resolved at Conversation-create time. Unlike
   * the Task default, the chat model is its own stored value (not derived from
   * the harness's `defaultModel`), so chat and Tasks can pin different models
   * of the same Harness.
   */
  chat: z.object({
    harness: z.enum(HARNESS_IDS).meta({ example: 'claude' }),
    model: z.string().meta({ example: 'claude-sonnet-5' }),
  }),
  /**
   * Global Auto-Runner settings (ADR-0012). `enabled` is the fleet-wide
   * **master switch** — the one-click pause that gates every Workspace
   * (a Task runs only if `master ∧ workspace-enabled`, where the per-Workspace
   * enable lives on the Workspace row and inherits when unset).
   * `maxConcurrentRuns` is the **Machine Ceiling**: the global cap on total
   * concurrent Runs across all Workspaces, which a per-Workspace cap override
   * can never breach (it is clamped to this — see `resolveCap`).
   */
  autoRunner: z.object({
    enabled: z.boolean().meta({ example: true }),
    maxConcurrentRuns: z.number().int().min(1).meta({ example: 3 }),
  }),
  /** Maximum failed implementation attempts before the ticket is escalated. */
  maxAttempts: z.number().int().min(1).default(2).meta({ example: 2 }),
  /** Reuse a warm Session into Attempt N+1 while its context occupancy stays
   * below this many tokens; at or above it, start a condensed new Session. A raw
   * token count (not a fraction), so it is independent of the model's window. */
  contextReuseTokenLimit: z.number().int().min(0).default(200_000).meta({ example: 200_000 }),
  /**
   * Auto-drive settings for afk mirrored Tasks (issue #33). `prompt` is the
   * global Drive Prompt template; `unattendedReminder` is appended to every
   * auto-driven turn and `continuePrompt` is the re-prompt nudge — both
   * operator-editable so the whole mirrored-drive prompt is visible, not
   * hardcoded. `mergeFate` is the default fate of a
   * completed worktree Run's branch (research Tasks are always artifacts);
   * `continueAttempts` is how many times a
   * Run that ended its turn without an explicit finish/escalate signal is
   * re-prompted to continue before the Run is treated as unresolved — 0 keeps
   * the old single-turn behaviour. `finish_task` (not the agent closing the
   * ticket) is the execution-complete signal: Harmonic verifies, merges per
   * `mergeFate`, and closes the ticket itself (issue #139).
   */
  drive: z
    .object({
      prompt: z.string().default(DEFAULT_DRIVE_PROMPT).meta({ example: DEFAULT_DRIVE_PROMPT }),
      unattendedReminder: z.string().default(UNATTENDED_REMINDER).meta({ example: UNATTENDED_REMINDER }),
      continuePrompt: z.string().default(DEFAULT_CONTINUE_PROMPT).meta({ example: DEFAULT_CONTINUE_PROMPT }),
      mergeFate: z.enum(MERGE_FATES).default('auto-merge').meta({ example: 'auto-merge' }),
      continueAttempts: z.number().int().min(0).default(1).meta({ example: 1 }),
    })
    .prefault({}),
  /**
   * The Task Prompt template for native (non-mirrored) Runs: the global,
   * operator-editable wrapper around a Task's own prompt, with `{prompt}` /
   * `{id}` / `{workingDir}` / `{harness}` / `{model}` placeholders. Defaults to
   * bare `{prompt}`, so out of the box the Task's prompt is sent verbatim.
   */
  taskPrompt: z.string().default(DEFAULT_TASK_PROMPT).meta({ example: DEFAULT_TASK_PROMPT }),
  /**
   * End a Conversation with no Turn for this many minutes (issue 15); its
   * transcript survives read-only. 0 disables the idle timeout. Fractional
   * values are allowed.
   */
  conversationIdleTimeoutMinutes: z.number().nonnegative().default(30).meta({ example: 30 }),
  /**
   * Global-default Verification config (issue #109/#132, ADR-0021): the command
   * verifier and the agent critic, each nullable and defaulting to null — nothing
   * configured — so the resolved verifier set is empty and a Run behaves exactly
   * as it does today. Per-Workspace overrides resolve per-key over these defaults
   * (`resolveVerifiers`, domain/setting-override.ts). Once configured, both the
   * command verifier and the agent critic execute live in the runner's
   * `validating`/`verifying` phases (`execution/runner.ts`) and gate merging
   * (#135/#164) — their verdicts feed `combineVerdicts` and drive settle.
   */
  /** Ordered verification contract. Commands fail fast; review runs last. */
  verify: z
    .object({
      commands: z.array(verificationCommandSchema).default([]),
      review: verificationReviewSchema.prefault({}),
    })
    .prefault({}),
  /**
   * Global-default Guardrail config (issue #108/#126, ADR-0019): the budget
   * Guardrail (mandatory wall-clock, optional tokens/cost) and the progress
   * (stall/loop) detector toggle, off by default until trace-validated. Resolve
   * as a global default with a per-Workspace override (`resolveGuardrails`,
   * domain/setting-override.ts); per-Task deferred. Enforced live: wall-clock
   * (#127), progress + tool-timeout (#131), and token/cost spend (#128). The
   * effective config + price table are snapshotted onto a Run at start so a
   * mid-Run change never retroactively trips it.
   *
   * `toolTimeoutMinutes` (issue #131) is a hard backstop paired with the
   * progress detector, not an override of it: the stall detector suspends
   * itself for the duration of any outstanding tool call (reliability-design
   * Unit A), so a genuinely hung tool call would otherwise never trip —
   * this bounds how long any single tool call may run before it does. The
   * default (20 minutes) is deliberately generous, well above any legitimate
   * slow build/test, so it only fires on a tool that is truly stuck.
   * Global-only: there is no per-Workspace override column for it yet.
   */
  guardrails: z
    .object({
      budget: budgetGuardrailSchema.prefault({}),
      progress: z.boolean().default(false),
      toolTimeoutMinutes: z.number().positive().default(20),
    })
    .prefault({}),
}).superRefine((config, ctx) => {
  // A harness's defaultModel must be one of its models (when any are
  // listed) — the Settings UI offers a select over `models`, and a stray
  // default would silently start Runs on an unintended model.
  for (const [id, harness] of Object.entries(config.harnesses)) {
    if (harness.models.length > 0 && !harness.models.includes(harness.defaultModel)) {
      ctx.addIssue({
        code: 'custom',
        path: ['harnesses', id, 'defaultModel'],
        message: `defaultModel must be one of the harness's models`,
      });
    }
  }
  // The chat default model must be one of its harness's models (same rationale
  // as defaultModel above — the Settings UI offers a select over that list, and
  // a stray value would silently start Conversations on an unintended model).
  const chatHarness = config.harnesses[config.chat.harness];
  if (chatHarness && chatHarness.models.length > 0 && !chatHarness.models.includes(config.chat.model)) {
    ctx.addIssue({
      code: 'custom',
      path: ['chat', 'model'],
      message: `chat model must be one of the ${config.chat.harness} harness's models`,
    });
  }
  // A cost cap you can't measure is a lie: if a cost budget is set with no token
  // fallback, every model a Run could pick must be priced — otherwise a Run on an
  // unpriced model has no enforceable spend bound (ADR-0019). Reject at config time
  // rather than accept-then-silently-ignore. A token fallback, or no cost cap, makes
  // any model fine.
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
        // Per the spike: the bare npm name `claude-code-acp` is a
        // low-fidelity third-party package; Zed's adapter is canonical.
        command: 'npx',
        args: ['--yes', '@agentclientprotocol/claude-agent-acp'],
        env: {},
        models: ['claude-opus-5', 'claude-fable-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
        defaultModel: 'claude-sonnet-5',
      },
      codex: {
        // Per the issue-22 spike: `codex acp` is not a subcommand; the
        // canonical ACP entry point is the adapter package (same org as
        // the Claude adapter), which bridges to its own bundled Codex.
        command: 'npx',
        args: ['--yes', '@agentclientprotocol/codex-acp'],
        env: {},
        // Verified against session/new's live availableModels (spike Q2).
        // Ids may carry a reasoning-effort suffix, e.g. gpt-5.4-mini[low].
        models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
        defaultModel: 'gpt-5.6-sol',
      },
      copilot: {
        // Per the issue-25 spike: `copilot --acp` speaks ACP on stdio
        // natively — no adapter package. The built-in github-mcp-server
        // is a per-session network dependency Runs don't need.
        command: 'copilot',
        args: ['--acp', '--disable-builtin-mcps'],
        env: {},
        // Verified against session/new's live availableModels on an
        // entitled plan (spike capture 12), minus ids with no published
        // API-equivalent rate (gemini-*, mai-*) — a shipped model must
        // have a shipped price. Operators whose plan serves those can add
        // them here plus a `prices` entry. Auto-only plans ignore any pin
        // (silently) and report whatever actually served.
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
      integrationRetries: 5,
      conflictResolveTurns: 2,
    },
    chat: {
      harness: 'claude',
      model: 'claude-sonnet-5',
    },
    autoRunner: {
      enabled: false,
      maxConcurrentRuns: 1,
    },
    maxAttempts: 2,
    contextReuseTokenLimit: 200_000,
    drive: {
      prompt: DEFAULT_DRIVE_PROMPT,
      unattendedReminder: UNATTENDED_REMINDER,
      continuePrompt: DEFAULT_CONTINUE_PROMPT,
      mergeFate: 'auto-merge',
      continueAttempts: 1,
    },
    taskPrompt: DEFAULT_TASK_PROMPT,
    conversationIdleTimeoutMinutes: 30,
    verify: {
      commands: [],
      review: { enabled: false },
    },
    guardrails: {
      budget: { wallClockMinutes: 60, tokens: null, costUsd: null },
      progress: false,
      toolTimeoutMinutes: 20,
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

/** A stored/patched config that may still carry the retired `agentReview` flag (#140). */
export type LegacyConfig = DeepPartial<AppConfig> & {
  agentReview?: boolean;
  verification?: { command?: VerificationCommand | null; critic?: VerificationCritic | null; autoAccept?: boolean; maxSelfHeals?: number };
  /** The retired context-reuse *fraction* (0–1), replaced by the raw-token
   * `contextReuseTokenLimit`. A fraction cannot map to a token count without a
   * model window, so it is dropped (falling to the new default), not converted. */
  contextReuseThreshold?: number;
};

/**
 * Fold retired verification input into `verify`. Legacy keys are accepted only at
 * this boundary and are never returned or persisted. An explicit `verify` value
 * always wins, including an empty command list or a disabled review.
 */
export function migrateLegacyConfig(raw: LegacyConfig): DeepPartial<AppConfig> {
  const { agentReview, verification: legacyVerification, contextReuseThreshold: _retiredReuseFraction, ...rest } = raw;
  const verify: DeepPartial<AppConfig['verify']> = { ...rest.verify };
  if (legacyVerification) {
    if (verify.commands === undefined && 'command' in legacyVerification) {
      verify.commands = legacyVerification.command === null ? [] : [legacyVerification.command!];
    }
    if (verify.review === undefined && 'critic' in legacyVerification) {
      verify.review = legacyVerification.critic === null ? { enabled: false } : { enabled: true, ...legacyVerification.critic! };
    }
    // Legacy `maxSelfHeals` and `autoAccept` are dropped, not migrated: the
    // self-heal budget was replaced by the top-level `maxAttempts` cap (#310),
    // and auto-accept described a review gate that no longer exists (ADR-0041).
  }
  return Object.keys(verify).length === 0 ? rest : { ...rest, verify };
}

export function defaultDataDir(): string {
  return process.env.HARMONIC_DATA_DIR ?? join(homedir(), '.harmonic');
}
