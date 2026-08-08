import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

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
 * the Task's Workflow / Wayfinder Type), `{ref}` `{url}` `{title}` `{body}` are
 * filled from the mirrored Task; the skill stays the source of truth, Harmonic
 * only injects the ticket and tells the agent to resolve + close it.
 */
export const DEFAULT_DRIVE_PROMPT = `{skill}

You are resolving tracker issue #{ref} ({url}) autonomously, end to end. When the work is done, comment on the issue summarising what you did and close it, following the repo's issue-tracker doc for the exact \`gh\` mechanics.

## {title}

{body}`;

/**
 * Appended to every auto-driven prompt (initial and continue) by
 * `AutoDrive.prompt`/`continuePrompt`. Harmonic settles a run when the prompt
 * turn resolves, so an agent that ends its turn to idle-wait used to look
 * "done". This tells the agent the turn boundary is a checkpoint, not an exit,
 * and gives it the two explicit signals the Runner reads — `finish_task` and
 * `escalate_task` — with its Harmonic Task id filled into `{taskId}`.
 */
export const UNATTENDED_REMINDER = `## You are running unattended

You are Harmonic Task #{taskId} and no human is watching this turn. Ending your turn does not hand back to a person — Harmonic treats it as a checkpoint and will prompt you to continue only a limited number of times. Do not stop to idle-wait for background work (CI, a watcher) or for input; that wastes those attempts. Instead:

- Keep working until the task is genuinely finished.
- When it is finished (ticket closed as above), call the \`finish_task\` tool with taskId={taskId} so Harmonic stops re-prompting you.
- If you are blocked on a decision or need input only a human can give, call the \`escalate_task\` tool with taskId={taskId} and a reason — do not guess and do not idle-wait.`;

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

export const appConfigSchema = z.object({
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
  }),
  autoRunner: z.object({
    enabled: z.boolean().meta({ example: true }),
    maxConcurrentRuns: z.number().int().min(1).meta({ example: 3 }),
  }),
  /**
   * Vestigial global tracker settings. Superseded by per-Workspace tracker
   * mirroring (issue #45): each Workspace now owns its own `trackerEnabled` +
   * `trackerPollIntervalSeconds` and its own poll loop. Kept in the schema so
   * existing configs/clients still validate; nothing reads it. The Settings-UI
   * split that removes it belongs to #42's config-split slice.
   * ponytail: dead config kept to avoid churning config/openapi/UI; delete with #42's Settings split.
   */
  tracker: z.object({
    enabled: z.boolean().meta({ example: false }),
    pollIntervalSeconds: z.number().int().min(5).meta({ example: 60 }),
  }),
  /**
   * Auto-drive settings for afk mirrored Tasks (issue #33). `prompt` is the
   * global Drive Prompt template; `mergeFate` is the default fate of a
   * completed worktree Run's branch (research Tasks are always artifacts);
   * `autoRetry` is how many times a failed afk Run is silently re-queued
   * before it Escalates to a human. `continueAttempts` is how many times a
   * Run that ended its turn without an explicit finish/escalate signal (and
   * with the ticket still open) is re-prompted to continue before the Run is
   * treated as unresolved — 0 keeps the old single-turn behaviour.
   */
  drive: z
    .object({
      prompt: z.string().default(DEFAULT_DRIVE_PROMPT).meta({ example: DEFAULT_DRIVE_PROMPT }),
      mergeFate: z.enum(MERGE_FATES).default('auto-merge').meta({ example: 'auto-merge' }),
      autoRetry: z.number().int().min(0).default(1).meta({ example: 1 }),
      continueAttempts: z.number().int().min(0).default(1).meta({ example: 1 }),
    })
    .prefault({}),
  /**
   * When true, Accept/Reject tools are exposed over MCP — agents can land
   * branches unattended (ADR-0002). Deliberate opt-in; default off.
   */
  agentReview: z.boolean().default(false).meta({ example: false }),
  /**
   * End a Conversation with no Turn for this many minutes (issue 15); its
   * transcript survives read-only. 0 disables the idle timeout. Fractional
   * values are allowed.
   */
  conversationIdleTimeoutMinutes: z.number().nonnegative().default(30).meta({ example: 30 }),
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
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type HarnessConfig = z.infer<typeof harnessConfigSchema>;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export function defaultConfig(): AppConfig {
  return {
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
    },
    autoRunner: {
      enabled: false,
      maxConcurrentRuns: 1,
    },
    tracker: {
      enabled: false,
      pollIntervalSeconds: 60,
    },
    drive: {
      prompt: DEFAULT_DRIVE_PROMPT,
      mergeFate: 'auto-merge',
      autoRetry: 1,
      continueAttempts: 1,
    },
    agentReview: false,
    conversationIdleTimeoutMinutes: 30,
  };
}

export function mergeConfig(base: AppConfig, overrides?: DeepPartial<AppConfig>): AppConfig {
  if (!overrides) return base;
  const merge = (a: any, b: any): any => {
    if (b === undefined) return a;
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
