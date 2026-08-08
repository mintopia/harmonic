import type { AppContext } from './app.js';
import type { ConversationRow, RunRow } from '../db/schema.js';
import type { TaskWithDeps } from '../domain/tasks.js';
import { costOfUsages, resolvePrices, type Cost } from '../execution/pricing.js';
import type { RunUsage } from '../execution/usage.js';

/**
 * API shapes for runs and tasks, used by both the REST routes and the
 * WebSocket broadcasts so the SPA sees one format (issue 15). Cost is
 * derived from stored Usage on every read — never persisted — so a price
 * change reprices all history.
 */

const parseUsage = (raw: string | null): RunUsage | null => (raw ? (JSON.parse(raw) as RunUsage) : null);

const pricesOf = (ctx: AppContext) => resolvePrices(ctx.configStore.get().prices);

/** A Task/Conversation row's `workspaceId` is nullable only because SQLite
 * can't add it NOT NULL to an existing table (schema.ts) — every row has one
 * at rest, so every API-facing shape narrows it back to `number` here. */
export const atRestWorkspaceId = (workspaceId: number | null): number => workspaceId!;

export type ApiRun = Omit<RunRow, 'usage'> & { usage: RunUsage | null; cost: Cost | null };

export function runToApi(ctx: AppContext, run: RunRow): ApiRun {
  const usage = parseUsage(run.usage);
  return { ...run, usage, cost: costOfUsages([usage], pricesOf(ctx)) };
}

export type ApiTask = Omit<TaskWithDeps, 'workspaceId'> & {
  workspaceId: number;
  cost: Cost | null;
  /** The mirrored issue's tracker URL, from the last poll's scan; null on native Tasks or before a poll (issue #35). */
  url: string | null;
  /** The parent Map's title, resolved from mapRef against the last poll's scan; null when unmapped or before a poll (issue #34). */
  mapTitle: string | null;
  /** The latest run's branch (worktree mode only); null in direct mode or before any run. */
  branch: string | null;
  /** The latest run's `git diff --stat`, snapshotted at settle; null until then or in direct mode. */
  stat: string | null;
};

/** A task's Cost sums ALL its runs — retries and failed attempts included. */
export function taskToApi(ctx: AppContext, task: TaskWithDeps): ApiTask {
  const runs = ctx.runs.listForTask(task.id);
  const usages = runs.map((run) => parseUsage(run.usage));
  return {
    ...task,
    workspaceId: atRestWorkspaceId(task.workspaceId),
    cost: costOfUsages(usages, pricesOf(ctx)),
    url: ctx.trackerManager.urlFor(task.workspaceId, task.trackerRef),
    mapTitle: ctx.trackerManager.titleForMap(task.workspaceId, task.mapRef),
    branch: runs.at(-1)?.branch ?? null,
    stat: runs.at(-1)?.stat ?? null,
  };
}

/** Cost of an arbitrary set of runs against the live price table. */
export function costOfRuns(ctx: AppContext, runs: RunRow[]): Cost | null {
  return costOfUsages(runs.map((run) => parseUsage(run.usage)), pricesOf(ctx));
}

export type ApiConversation = Omit<ConversationRow, 'usage' | 'workspaceId'> & {
  workspaceId: number;
  /** Running Usage accumulated across Turns (issue 12); null before any usage. */
  usage: RunUsage | null;
  /** Cost of the running Usage against the live price table; honest-incomplete. */
  cost: Cost | null;
  /** The latest Turn's input-side token footprint (context fill); null when unknown. */
  contextTokens: number | null;
  /** The model's configured context window; null when unconfigured (percentage suppressed). */
  contextWindow: number | null;
  /** The model's configured cache TTL in seconds; null when unconfigured (cold-cache banner suppressed). */
  cacheTtlSeconds: number | null;
};

/** The display title: the operator's title, else derived from the first Turn's first non-empty line (issue 15). */
const DERIVED_TITLE_MAX = 80;
function deriveConversationTitle(firstTurnText: string | null): string | null {
  if (!firstTurnText) return null;
  const line = firstTurnText.split('\n').find((l) => l.trim().length > 0)?.trim();
  if (!line) return null;
  return line.length > DERIVED_TITLE_MAX ? `${line.slice(0, DERIVED_TITLE_MAX - 1).trimEnd()}…` : line;
}

/**
 * A Conversation as the REST API and firehose both serve it — one format for
 * the SPA. Running Usage/Cost are derived on read (issue 12), the title falls
 * back to one derived from the first Turn (issue 15), and the context-window
 * / cache-TTL facts come from optional per-model config; honest degradation
 * when unconfigured (null, never a fake percentage).
 */
export function conversationToApi(ctx: AppContext, conversation: ConversationRow): ApiConversation {
  const { usage: rawUsage, ...rest } = conversation;
  const usage = parseUsage(rawUsage);
  const config = ctx.configStore.get();
  const modelInfo = config.modelInfo[conversation.model] ?? config.modelInfo[conversation.model.replace(/-\d{8}$/, '')];
  return {
    ...rest,
    workspaceId: atRestWorkspaceId(conversation.workspaceId),
    title: conversation.title ?? deriveConversationTitle(ctx.conversations.firstTurnText(conversation.id)),
    usage,
    cost: costOfUsages([usage], pricesOf(ctx)),
    contextTokens: conversation.contextTokens,
    contextWindow: modelInfo?.contextWindow ?? null,
    cacheTtlSeconds: modelInfo?.cacheTtlSeconds ?? null,
  };
}
