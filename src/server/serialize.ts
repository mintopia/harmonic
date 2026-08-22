import type { AppContext } from './app.js';
import type { ConversationRow, ConversationState, RunRow, RunState } from '../db/schema.js';
import type { TaskWithDeps } from '../domain/tasks.js';
import { costOfUsages, resolvePrices, sumCosts, type Cost } from '../execution/pricing.js';
import type { ProcessTree, RunUsage, RunUsageSnapshot } from '../execution/usage.js';

/**
 * API shapes for runs and tasks, used by both the REST routes and the
 * WebSocket broadcasts so the SPA sees one format (issue 15). Settled Run
 * Costs are stored and frozen; only live Usage is priced on read.
 */

const parseUsage = (raw: string | null): RunUsage | null => (raw ? (JSON.parse(raw) as RunUsage) : null);
const parseCost = (raw: string | null): Cost | null => (raw ? (JSON.parse(raw) as Cost) : null);

const pricesOf = (ctx: AppContext) => resolvePrices(ctx.configStore.get().prices);

/** A Task/Conversation row's `workspaceId` is nullable only because SQLite
 * can't add it NOT NULL to an existing table (schema.ts) — every row has one
 * at rest, so every API-facing shape narrows it back to `number` here. */
export const atRestWorkspaceId = (workspaceId: number | null): number => workspaceId!;

export type ApiRun = Omit<RunRow, 'usage' | 'liveUsage' | 'cost'> & { usage: RunUsage | null; cost: Cost | null };

export function runToApi(_ctx: AppContext, run: RunRow): ApiRun {
  const usage = parseUsage(run.usage);
  // liveUsage is the Activity view's live/persisted snapshot, streamed as a
  // `run_usage` firehose event — not part of the run's REST shape.
  const { liveUsage, ...rest } = run;
  return { ...rest, usage, cost: parseCost(run.cost) };
}

/** The firehose shape of a live-usage snapshot (ADR 0010): the persisted
 * snapshot plus Cost derived from its Usage on read, like every other Cost. */
export type ApiRunUsage = RunUsageSnapshot & { cost: Cost | null };

export function runUsageToApi(ctx: AppContext, snapshot: RunUsageSnapshot): ApiRunUsage {
  return { ...snapshot, cost: costOfUsages([snapshot.usage], pricesOf(ctx)) };
}

/** The durable tracker-fact columns (issue #233) are server-side persistence
 * only — write-only, no consumer reads them yet — so they never enter the API
 * shape. Omitting them here keeps the WS broadcast and the zod-validated REST
 * response identical (streaming.test.ts parity). */
type TrackerFactColumns =
  | 'trackerState'
  | 'trackerParent'
  | 'trackerBlockedBy'
  | 'trackerLabels'
  | 'trackerTitle'
  | 'trackerBody'
  | 'trackerUrl'
  | 'trackerCreatedAt';

export type ApiTask = Omit<TaskWithDeps, 'workspaceId' | TrackerFactColumns> & {
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
  /** The running run's `startedAt`; null unless the Task is running — the board card's live elapsed figure (issue #100). */
  runStartedAt: number | null;
  /** Total tool-call count of the running run; null unless the Task is running — the board card's "· N tools" (issue #100). */
  toolCount: number | null;
  /** The running run's id, so the board can match the `run_usage` firehose to this card; null unless the Task is running (issue #100). */
  runId: number | null;
  /** The current scheduler reason this Task was not picked for, such as a
   * dependency, capacity, disabled Workspace, or missing integration branch;
   * null when it is not waiting (issue #238). */
  skipReason: string | null;
  /** The latest run's frozen verification candidate ref (issue #134); null
   * when no run has produced a candidate yet (pre-feature, escalated before
   * `validating`, or a dirty direct-mode context). Surfaced so an escalated
   * Task's stranded candidate can be adopted for review, or re-reviewed with
   * an operator note, without a fresh builder run (issue #191). */
  candidateRef: string | null;
};

/** A task's Cost sums ALL its runs — retries and failed attempts included. */
export async function taskToApi(ctx: AppContext, task: TaskWithDeps): Promise<ApiTask> {
  const runs = await ctx.runs.listForTask(task.id);
  const running = task.state === 'running' ? runs.find((r) => r.state === 'running') : undefined;
  return taskToApiWithRuns(ctx, task, runs, running ? await runningToolCount(ctx, running) : null);
}

/** Serialize a task list from its already-batched Runs (issue #258). */
export async function tasksToApi(ctx: AppContext, tasks: TaskWithDeps[]): Promise<ApiTask[]> {
  if (tasks.length === 0) return [];
  const runsByTask = new Map(tasks.map((task) => [task.id, [] as RunRow[]]));
  for (const run of await ctx.runs.listForTasks(tasks.map((task) => task.id))) runsByTask.get(run.taskId)?.push(run);
  const running = tasks.flatMap((task) => {
    const run = task.state === 'running' ? runsByTask.get(task.id)?.find((candidate) => candidate.state === 'running') : undefined;
    return run ? [run] : [];
  });
  const toolCounts = await ctx.runs.toolCallCounts(running.map((run) => run.id));
  return tasks.map((task) => {
    const runs = runsByTask.get(task.id) ?? [];
    const activeRun = task.state === 'running' ? runs.find((run) => run.state === 'running') : undefined;
    return taskToApiWithRuns(ctx, task, runs, activeRun ? toolCounts.get(activeRun.id) ?? 0 : null);
  });
}

/** Peel the durable tracker-fact columns (issue #233) off a task: they are
 * server-side persistence only, so they never enter the API shape — dropping
 * them keeps the WS broadcast and the zod-validated REST response identical
 * (streaming.test.ts parity). */
function stripTrackerFactCols(task: TaskWithDeps): Omit<TaskWithDeps, TrackerFactColumns> {
  const {
    trackerState, trackerParent, trackerBlockedBy, trackerLabels,
    trackerTitle, trackerBody, trackerUrl, trackerCreatedAt,
    ...rest
  } = task;
  return rest;
}

function taskToApiWithRuns(ctx: AppContext, task: TaskWithDeps, runs: RunRow[], toolCount: number | null): ApiTask {
  const running = task.state === 'running' ? runs.find((r) => r.state === 'running') : undefined;
  return {
    ...stripTrackerFactCols(task),
    workspaceId: atRestWorkspaceId(task.workspaceId),
    cost: sumCosts(runs.map((run) => parseCost(run.cost))),
    url: ctx.trackerManager.urlFor(task.workspaceId, task.trackerRef),
    mapTitle: ctx.trackerManager.titleForMap(task.workspaceId, task.mapRef),
    branch: runs.at(-1)?.branch ?? null,
    stat: runs.at(-1)?.stat ?? null,
    runStartedAt: running?.startedAt ?? null,
    toolCount,
    runId: running?.id ?? null,
    skipReason: ctx.autoRunner.skipReasonFor(task.id) ?? null,
    candidateRef: runs.at(-1)?.candidateRef ?? null,
  };
}

/** Total tool calls of a running run from its native aggregate (ADR-0031). */
async function runningToolCount(ctx: AppContext, run: RunRow): Promise<number> {
  const totals = await ctx.runs.listToolCalls(run.id);
  let count = 0;
  for (const total of totals.values()) count += total;
  return count;
}

/** Cost of an arbitrary set of Runs, summed from their frozen values. */
export function costOfRuns(runs: RunRow[]): Cost | null {
  return sumCosts(runs.map((run) => parseCost(run.cost)));
}

/** One live process in the Activity snapshot (issue #51); see `activitySnapshot`. */
export interface ApiActivityProcess {
  type: 'run' | 'chat';
  /** The Run's id (type `run`), else null. */
  runId: number | null;
  /** The Conversation's id (type `chat`), else null. */
  conversationId: number | null;
  /** The owning Task's id (type `run`), else null. */
  taskId: number | null;
  /** The process's display title: a Run's Task prompt first line, a Conversation's title (issue #52). */
  title: string;
  workspaceId: number;
  /** The owning Workspace's name — the Activity view spans Workspaces, so each row names its own (issue #52). */
  workspaceName: string;
  harness: string;
  model: string;
  /** A running Run's RunState, or a warm Conversation's ConversationState. */
  state: RunState | ConversationState;
  /** Isolation Mode: `worktree`/`direct` for a Run; always `direct` for a Conversation (ADR-0006). */
  isolation: string;
  /** Epoch ms the process started; the client derives elapsed from it. */
  startedAt: number;
  /** The mirrored issue's tracker ref (a Run's Task); null on native Tasks and Conversations. */
  trackerRef: number | null;
  /** The mirrored issue's tracker URL — the Activity row's ticket deep-link (issue #55); null on native Tasks, Conversations, or before a poll. */
  trackerUrl: string | null;
  /** True when an afk Run escalated to a human at runtime (issue #33) — the Activity view's "Needs you" signal; always false for a Conversation. */
  escalated: boolean;
  usage: RunUsage | null;
  contextTokens: number | null;
  /** The model's configured context window; null when unconfigured — the context gauge shows raw tokens, never a fabricated percentage (issue #52). */
  contextWindow: number | null;
  /** One-line current-activity (Runs only); null for a Conversation. */
  activity: string | null;
  /** The process's Process Tree (Runs only); null for a Conversation. */
  tree: ProcessTree | null;
  cost: Cost | null;
}

/**
 * The instance-wide Activity snapshot (issue #51, ADR 0010): every live
 * process across Workspaces. Runs come from the persisted capacity set, then
 * join a Runner snapshot when one is live, so a wedged Run remains visible even
 * after it has left the in-memory registry. A Run carries its live-usage
 * snapshot — rolled-up Usage, context fill, current-activity line, Process
 * Tree — with Cost derived on read like every other Cost. A Conversation has no
 * live tailer, so its `tree`/`activity` are null and its Usage/context come from
 * the Conversation row. `includeChats` is false for a Read Key (a read-scoped
 * viz client): Runs only, mirroring the firehose filter that hides Conversation
 * traffic from Read Keys.
 */
export async function activitySnapshot(ctx: AppContext, includeChats: boolean): Promise<ApiActivityProcess[]> {
  const prices = pricesOf(ctx);
  const snapshots = new Map((await ctx.runner.activeSnapshots()).map((snapshot) => [snapshot.runId, snapshot.snapshot]));
  const runs: ApiActivityProcess[] = await Promise.all((await ctx.runs.listRunning()).map(async (run) => {
    const task = await ctx.tasks.get(run.taskId);
    const snapshot = snapshots.get(run.id) ?? null;
    return {
      type: 'run',
      runId: run.id,
      conversationId: null,
      taskId: run.taskId,
      title: firstLineTitle(task.prompt) ?? `Task ${run.taskId}`,
      workspaceId: atRestWorkspaceId(task.workspaceId),
      workspaceName: await workspaceNameOf(ctx, task.workspaceId),
      harness: task.harness,
      model: task.model,
      state: run.state,
      isolation: task.isolationMode,
      startedAt: run.startedAt,
      trackerRef: task.trackerRef,
      trackerUrl: ctx.trackerManager.urlFor(task.workspaceId, task.trackerRef),
      escalated: task.escalated,
      usage: snapshot?.usage ?? null,
      contextTokens: snapshot?.contextTokens ?? null,
      contextWindow: contextWindowOf(ctx, task.model),
      activity: snapshot?.activity ?? null,
      tree: snapshot?.tree ?? null,
      cost: snapshot ? costOfUsages([snapshot.usage], prices) : null,
    };
  }));
  if (!includeChats) return runs;
  const chats: ApiActivityProcess[] = await Promise.all(ctx.conversationDriver.activeConversationIds().map(async (id) => {
    const convo = await ctx.conversations.get(id);
    const usage = parseUsage(convo.usage);
    return {
      type: 'chat',
      runId: null,
      conversationId: id,
      taskId: null,
      title: convo.title ?? firstLineTitle(await ctx.conversations.firstTurnText(id)) ?? `Conversation #${id}`,
      workspaceId: atRestWorkspaceId(convo.workspaceId),
      workspaceName: await workspaceNameOf(ctx, convo.workspaceId),
      harness: convo.harness,
      model: convo.model,
      state: convo.state,
      isolation: 'direct',
      startedAt: convo.createdAt,
      trackerRef: null,
      trackerUrl: null,
      escalated: false,
      usage,
      contextTokens: convo.contextTokens,
      contextWindow: contextWindowOf(ctx, convo.model),
      activity: null,
      tree: null,
      cost: costOfUsages([usage], prices),
    };
  }));
  return [...runs, ...chats];
}

/** The Workspace's name for an at-rest workspaceId — every live process names its own Workspace (issue #52). */
async function workspaceNameOf(ctx: AppContext, workspaceId: number | null): Promise<string> {
  return (await ctx.workspaces.get(atRestWorkspaceId(workspaceId))).name;
}

/** A model's configured context window (exact id, then the undated base id), or null when unconfigured — mirrors `conversationToApi` (issue #52). */
function contextWindowOf(ctx: AppContext, model: string): number | null {
  const info = ctx.configStore.get().modelInfo;
  return (info[model] ?? info[model.replace(/-\d{8}$/, '')])?.contextWindow ?? null;
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

/** First non-empty line of `text`, clamped to `DERIVED_TITLE_MAX` with an ellipsis; null when blank. Shared by the
 * Conversation title fallback (issue 15) and the Activity view's per-process title (issue #52). */
export function firstLineTitle(text: string | null): string | null {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim();
  if (!line) return null;
  return line.length > DERIVED_TITLE_MAX ? `${line.slice(0, DERIVED_TITLE_MAX - 1).trimEnd()}…` : line;
}

function deriveConversationTitle(firstTurnText: string | null): string | null {
  return firstLineTitle(firstTurnText);
}

/**
 * A Conversation as the REST API and firehose both serve it — one format for
 * the SPA. Running Usage/Cost are derived on read (issue 12), the title falls
 * back to one derived from the first Turn (issue 15), and the context-window
 * / cache-TTL facts come from optional per-model config; honest degradation
 * when unconfigured (null, never a fake percentage).
 */
export async function conversationToApi(ctx: AppContext, conversation: ConversationRow): Promise<ApiConversation> {
  const { usage: rawUsage, ...rest } = conversation;
  const usage = parseUsage(rawUsage);
  const config = ctx.configStore.get();
  const modelInfo = config.modelInfo[conversation.model] ?? config.modelInfo[conversation.model.replace(/-\d{8}$/, '')];
  return {
    ...rest,
    workspaceId: atRestWorkspaceId(conversation.workspaceId),
    title: conversation.title ?? deriveConversationTitle(await ctx.conversations.firstTurnText(conversation.id)),
    usage,
    cost: costOfUsages([usage], pricesOf(ctx)),
    contextTokens: conversation.contextTokens,
    contextWindow: modelInfo?.contextWindow ?? null,
    cacheTtlSeconds: modelInfo?.cacheTtlSeconds ?? null,
  };
}
