import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const HARNESS_IDS = ['claude', 'codex', 'copilot'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const ISOLATION_MODES = ['direct', 'worktree'] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

export const PRIORITIES = ['high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const harnessConfigSchema = z.object({
  /** Command + args spawned to speak ACP on stdio. */
  command: z.string(),
  args: z.array(z.string()).default([]),
  /** Extra environment for the spawned process (e.g. API keys). */
  env: z.record(z.string(), z.string()).default({}),
  models: z.array(z.string()).default([]),
  defaultModel: z.string(),
  /**
   * Root of the harness's native session logs, for the per-model usage
   * fallback (Claude Code: ~/.claude/projects). Empty string disables.
   */
  sessionLogDir: z.string().optional(),
});

/** Per-model API rates in $/Mtok; must match `ModelPrice` in execution/pricing.ts. */
export const modelPriceSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});

export const appConfigSchema = z.object({
  harnesses: z.record(z.enum(HARNESS_IDS), harnessConfigSchema),
  /**
   * Price-table overrides for Cost: entries here override or extend the
   * shipped `DEFAULT_PRICES` (execution/pricing.ts). Riding the config
   * means they ride config-repo export/import too.
   */
  prices: z.record(z.string(), modelPriceSchema).default({}),
  defaults: z.object({
    harness: z.enum(HARNESS_IDS),
    workingDir: z.string(),
    isolationMode: z.enum(ISOLATION_MODES),
    priority: z.enum(PRIORITIES),
  }),
  autoRunner: z.object({
    enabled: z.boolean(),
    maxConcurrentRuns: z.number().int().min(1),
  }),
  /**
   * When true, Accept/Reject tools are exposed over MCP — agents can land
   * branches unattended (ADR-0002). Deliberate opt-in; default off.
   */
  agentReview: z.boolean().default(false),
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
        models: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
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
        command: 'copilot',
        args: ['--acp'],
        env: {},
        models: ['claude-sonnet-5', 'gpt-5.2'],
        defaultModel: 'claude-sonnet-5',
      },
    },
    prices: {},
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
    agentReview: false,
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
  return process.env.AGENTDECK_DATA_DIR ?? join(homedir(), '.agentdeck');
}
