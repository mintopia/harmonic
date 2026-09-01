import type { AppContext } from './app.js';
import type { AttemptRow, VerificationAttemptRow, StepType, ConversationRow } from '../db/schema.js';
import { attempts, steps, guardrailEvents, attemptEvents, verificationAttempts } from '../db/schema.js';
import { and, desc, eq } from 'drizzle-orm';
import type { TaskWithDeps } from '../domain/tasks.js';
import { resolveVerifiers } from '../domain/setting-override.js';
import { verifierStatuses, type VerifierStatus } from '../domain/verifier-status.js';
import { costOfUsages, resolveContextWindow, resolvePrices } from '../domain/pricing.js';
import type { AttemptUsageSnapshot } from '../execution/usage.js';
import { Git } from '../execution/git.js';
import { forEachYielding } from '../reliability/yield.js';
import {
  atRestWorkspaceId,
  parseUsage,
  attemptToTimelineApi,
  attemptToApiSummary,
  taskToApiDto,
  toListRow,
  latestVerifiedRef,
  attemptProcessToApi,
  conversationProcessToApi,
  conversationToApiDto,
  deriveConversationTitle,
  firstLineTitle,
  type ApiAttemptTimeline,
  type ApiTicketTimelineEvent,
  type ApiAttemptSummary,
  type ApiAttemptUsage,
  type ApiTask,
  type ApiTaskListRow,
  type ApiActivityProcess,
  type ApiConversation,
} from './dto.js';

/**
 * Read-model builders for the API shapes of attempts, tasks, and conversations,
 * used by both the REST routes and the WebSocket broadcasts so the SPA sees one
 * format (issue 15). Each builder does the multi-store query orchestration and
 * then hands the fetched rows to a pure row->DTO mapper in `dto.ts`.
 */

const pricesOf = (ctx: AppContext) => resolvePrices(ctx.settingsStore.getGlobal().prices);

/** One DTO builder for REST hydration and live timeline updates. */
export async function attemptTimelineToApi(ctx: AppContext, taskId: number): Promise<ApiAttemptTimeline> {
  const [task, rows, budgetBase] = await Promise.all([
    ctx.tasks.get(taskId),
    ctx.attempts.listForTask(taskId),
    ctx.attempts.budgetBase(taskId),
  ]);
  const workspace = await ctx.workspaces.get(atRestWorkspaceId(task.workspaceId));
  const configuredVerifiers = resolveVerifiers(workspace, ctx.settingsStore.getGlobal());
  return {
    budgetBase,
    attempts: await Promise.all(rows.map(async (attempt) => {
      const [stepRows, attemptVerifications] = await Promise.all([
        ctx.attempts.listSteps(attempt.id),
        ctx.verificationAttempts.list(attempt.id),
      ]);
      return attemptToTimelineApi(attempt, stepRows, attemptVerifications, configuredVerifiers);
    })),
  };
}

/** The configured-or-recorded verifier rows for one Run's always-visible read model. */
export async function verifierStatusesToApi(
  ctx: AppContext,
  run: Pick<AttemptRow, 'id' | 'taskId' | 'number'>,
  recordedAttempts?: readonly VerificationAttemptRow[],
): Promise<VerifierStatus[]> {
  const task = await ctx.tasks.get(run.taskId);
  const workspace = await ctx.workspaces.get(atRestWorkspaceId(task.workspaceId));
  const listAttempts = async (): Promise<readonly VerificationAttemptRow[]> => {
    if (recordedAttempts) return recordedAttempts;
    const attempt = await ctx.attempts.getForTaskNumber(run.taskId, run.number);
    return attempt ? ctx.verificationAttempts.list(attempt.id) : [];
  };
  const [attempts, stepType] = await Promise.all([
    listAttempts(),
    ctx.attempts.currentStepType(run.taskId, run.number),
  ]);
  return verifierStatuses({ verifiers: resolveVerifiers(workspace, ctx.settingsStore.getGlobal()), attempts, stepType });
}

type PendingTicketTimelineEvent = ApiTicketTimelineEvent & { order: number };

/**
 * Ticket-wide event projection for issue #328. Each persisted source is read
 * once for the ticket, then folded in memory. The fixed query count avoids a
 * per-Attempt and per-event read pattern that would starve the shared event loop.
 */
const TICKET_TIMELINE_SOURCE_LIMIT = 1_000;

export async function ticketTimelineToApi(ctx: AppContext, taskId: number): Promise<{ events: ApiTicketTimelineEvent[] }> {
  const [taskAttempts, lifecycle, verification, skippedVerification, guardrails] = await Promise.all([
    ctx.asyncDb.read((db) => db.select().from(attempts).where(eq(attempts.taskId, taskId)).orderBy(desc(attempts.startedAt), desc(attempts.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
    ctx.asyncDb.read((db) => db.select({ event: attemptEvents }).from(attemptEvents).innerJoin(attempts, eq(attemptEvents.attemptId, attempts.id)).where(and(eq(attempts.taskId, taskId), eq(attemptEvents.type, 'lifecycle'))).orderBy(desc(attemptEvents.ts), desc(attemptEvents.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
    ctx.asyncDb.read((db) => db.select({ attempt: verificationAttempts }).from(verificationAttempts).innerJoin(attempts, eq(verificationAttempts.attemptId, attempts.id)).where(eq(attempts.taskId, taskId)).orderBy(desc(verificationAttempts.ts), desc(verificationAttempts.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
    ctx.asyncDb.read((db) => db.select({ step: steps }).from(steps).innerJoin(attempts, eq(steps.attemptId, attempts.id)).where(eq(attempts.taskId, taskId)).orderBy(desc(steps.endedAt), desc(steps.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
    ctx.asyncDb.read((db) => db.select({ event: guardrailEvents }).from(guardrailEvents).innerJoin(attempts, eq(guardrailEvents.attemptId, attempts.id)).where(eq(attempts.taskId, taskId)).orderBy(desc(guardrailEvents.ts), desc(guardrailEvents.id)).limit(TICKET_TIMELINE_SOURCE_LIMIT).all()),
  ]);
  const task = await ctx.tasks.get(taskId);
  const workspace = await ctx.workspaces.get(atRestWorkspaceId(task.workspaceId));
  const configuredVerifiers = resolveVerifiers(workspace, ctx.settingsStore.getGlobal());
  const attemptsByNumber = new Map<number, AttemptRow>(taskAttempts.map((a) => [a.number, a]));
  const verificationByAttempt = new Map<number, VerificationAttemptRow[]>();
  for (const { attempt: v } of verification) {
    const rows = verificationByAttempt.get(v.attemptId) ?? [];
    rows.push(v);
    verificationByAttempt.set(v.attemptId, rows);
  }
  const pending: PendingTicketTimelineEvent[] = [];
  const add = (event: ApiTicketTimelineEvent, order: number) => pending.push({ ...event, order });

  await forEachYielding(taskAttempts, async (attempt) => {
    for (const status of verifierStatuses({ verifiers: configuredVerifiers, attempts: verificationByAttempt.get(attempt.id) ?? [] })) {
      if (status.state !== 'disabled') continue;
      add({
        attemptId: attempt.id,
        ts: attempt.endedAt ?? attempt.startedAt,
        kind: 'verification',
        data: { outcome: 'disabled', mechanism: status.mechanism, reason: status.reason, derived: true },
      }, 2);
    }
  });
  await forEachYielding(taskAttempts, async (attempt) => {
    add({ attemptId: attempt.id, ts: attempt.startedAt, kind: 'attempt-started', data: { attempt: attempt.number, state: attempt.state } }, 0);
    if (attempt.endedAt !== null) add({ attemptId: attempt.id, ts: attempt.endedAt, kind: 'attempt-finished', data: { attempt: attempt.number, state: attempt.state, feedback: attempt.feedback, reason: attempt.reason } }, 7);
  });
  await forEachYielding(taskAttempts, async (attempt) => {
    const rejected = attemptsByNumber.get(attempt.number - 1);
    if (rejected?.state === 'escalated' && rejected.feedback !== null) add({ attemptId: rejected.id, ts: attempt.startedAt, kind: 'operator-reject', data: { attempt: rejected.number, feedback: rejected.feedback } }, 4);
  });
  await forEachYielding(lifecycle, async ({ event }) => { add({ attemptId: event.attemptId, ts: event.ts, kind: 'lifecycle', data: { type: event.type, payload: JSON.parse(event.payload) } }, 3); });
  await forEachYielding(verification, async ({ attempt }) => { add({ attemptId: attempt.attemptId, ts: attempt.ts, kind: 'verification', data: { mechanism: attempt.mechanism, verdict: attempt.verdict, summary: attempt.summary, inputOid: attempt.inputOid } }, 2); });
  await forEachYielding(skippedVerification, async ({ step }) => {
    if (step.type !== 'verification' || step.state !== 'skipped' || step.endedAt === null) return;
    add({ attemptId: step.attemptId, ts: step.endedAt, kind: 'verification', data: { outcome: 'skipped', command: step.command, verdict: step.verdict } }, 2);
  });
  await forEachYielding(guardrails, async ({ event }) => { add({ attemptId: event.attemptId, ts: event.ts, kind: 'guardrail', data: { dimension: event.dimension, limitValue: event.limitValue, observedValue: event.observedValue, configSource: event.configSource, payload: JSON.parse(event.payload) } }, 2); });

  // The Task's own creation — the head of the lifecycle, before any Attempt.
  // `order: -1` seats it first even against an Attempt started at the same ms.
  add({ attemptId: null, ts: task.createdAt, kind: 'fact', data: { type: 'task-created', trackerRef: task.trackerRef != null ? String(task.trackerRef) : null, workspace: workspace?.name ?? null } }, -1);

  return {
    events: pending
      .sort((a, b) => a.ts - b.ts || a.order - b.order || (a.attemptId ?? 0) - (b.attemptId ?? 0))
      .map(({ order: _order, ...event }) => event),
  };
}

export async function attemptToApi(ctx: AppContext, run: AttemptRow): Promise<ApiAttemptSummary> {
  // The per-Attempt tool-call total from its native aggregate (ADR-0031) — one
  // bounded read per Attempt (attempts-per-Task is small), no event replay.
  const [toolTotals, task] = await Promise.all([ctx.attempts.listToolCalls(run.id), ctx.tasks.get(run.taskId)]);
  let toolCalls = 0;
  for (const total of toolTotals.values()) toolCalls += total;
  return attemptToApiSummary(run, toolCalls, contextWindowOf(ctx, task.model));
}

export function attemptUsageToApi(ctx: AppContext, snapshot: AttemptUsageSnapshot): ApiAttemptUsage {
  return { ...snapshot, cost: costOfUsages([snapshot.usage], pricesOf(ctx)) };
}

/** A task's Cost sums ALL its runs — retries and failed attempts included. */
export async function taskToApi(ctx: AppContext, task: TaskWithDeps): Promise<ApiTask> {
  const runs = await ctx.attempts.listForTask(task.id);
  const running = task.state === 'working' ? runs.find((r) => r.state === 'running') : undefined;
  const currentStep = running ? await ctx.attempts.currentStepType(task.id, running.number) : null;
  const hasCandidate = await hasCandidateFor(task, runs.at(-1));
  return taskToApiWithRuns(ctx, task, runs, running ? await runningToolCount(ctx, running) : null, currentStep, hasCandidate);
}

/** Serialize a task list from its already-batched Runs (issue #258). The rows
 * are lean (ADR-0045, issue #350): the full `prompt` is dropped in favour of
 * `summary`, so no list surface carries the whole prompt. */
export async function tasksToApi(ctx: AppContext, tasks: TaskWithDeps[]): Promise<ApiTaskListRow[]> {
  if (tasks.length === 0) return [];
  const runsByTask = new Map(tasks.map((task) => [task.id, [] as AttemptRow[]]));
  for (const run of await ctx.attempts.listForTasks(tasks.map((task) => task.id))) runsByTask.get(run.taskId)?.push(run);
  const running = tasks.flatMap((task) => {
    const run = task.state === 'working' ? runsByTask.get(task.id)?.find((candidate) => candidate.state === 'running') : undefined;
    return run ? [run] : [];
  });
  // `attempt_tool_calls` is keyed off `attempt_id`: resolve each running
  // Task's current Attempt id first, then batch the tool-call totals by
  // Attempt — `toolCountByTask` re-keys the result back onto the Task id every
  // list-row render already has to hand.
  const attemptIdByTask = await ctx.attempts.idsFor(running.map((run) => ({ taskId: run.taskId, number: run.number })));
  const [toolCountsByAttempt, currentSteps, hasCandidates] = await Promise.all([
    ctx.attempts.toolCallCounts([...attemptIdByTask.values()]),
    ctx.attempts.currentStepTypes(running.map((run) => ({ taskId: run.taskId, number: run.number }))),
    Promise.all(tasks.map((task) => hasCandidateFor(task, (runsByTask.get(task.id) ?? []).at(-1)))),
  ]);
  return tasks.map((task, i) => {
    const runs = runsByTask.get(task.id) ?? [];
    const activeRun = task.state === 'working' ? runs.find((run) => run.state === 'running') : undefined;
    const activeAttemptId = activeRun ? attemptIdByTask.get(task.id) : undefined;
    return toListRow(taskToApiWithRuns(
      ctx,
      task,
      runs,
      activeRun ? (activeAttemptId != null ? toolCountsByAttempt.get(activeAttemptId) ?? 0 : 0) : null,
      activeRun ? currentSteps.get(task.id) ?? null : null,
      hasCandidates[i]!,
    ));
  });
}

/** Whether an Accept has a candidate to merge (issue #429): true once
 * `latestVerifiedRef` is set (the common, already-verified case), or — for an
 * escalated worktree Task that never reached verification (a guardrail/infra
 * escalation, e.g. tasks 410/411) — once its branch actually has commits
 * ahead of its base. That git call is scoped to escalated worktree Tasks only
 * (cheap: escalated Tasks are few) so every other Task resolves with no I/O. */
async function hasCandidateFor(task: TaskWithDeps, lastRun: AttemptRow | undefined): Promise<boolean> {
  let hasCandidate = latestVerifiedRef(lastRun) !== null;
  if (!hasCandidate && task.state === 'escalated' && task.isolationMode === 'worktree' && lastRun?.branch && lastRun?.baseBranch) {
    hasCandidate = (await Git.commitsAhead(task.workingDir, lastRun.baseBranch, lastRun.branch)) > 0;
  }
  return hasCandidate;
}

function taskToApiWithRuns(
  ctx: AppContext,
  task: TaskWithDeps,
  runs: AttemptRow[],
  toolCount: number | null,
  currentStep: StepType | null,
  hasCandidate: boolean,
): ApiTask {
  return taskToApiDto(task, runs, {
    toolCount,
    currentStep,
    hasCandidate,
    url: ctx.trackerManager.urlFor(task.workspaceId, task.trackerRef),
    mapTitle: ctx.trackerManager.titleForMap(task.workspaceId, task.mapRef),
    skipReason: ctx.autoRunner.skipReasonFor(task.id) ?? null,
    contextWindow: contextWindowOf(ctx, task.model),
  });
}

/** Total tool calls of a running Attempt from its native aggregate (ADR-0031). */
async function runningToolCount(ctx: AppContext, run: AttemptRow): Promise<number> {
  const attempt = await ctx.attempts.getForTaskNumber(run.taskId, run.number);
  if (!attempt) return 0;
  const totals = await ctx.attempts.listToolCalls(attempt.id);
  let count = 0;
  for (const total of totals.values()) count += total;
  return count;
}

/**
 * The instance-wide Activity snapshot (issue #51, ADR 0010): every live
 * process across Workspaces. Runs come from the persisted capacity set, then
 * join a Runner snapshot when one is live, so a wedged Run remains visible even
 * after it has left the in-memory registry. `includeChats` is false for a Read
 * Key (a read-scoped viz client): Runs only, mirroring the firehose filter that
 * hides Conversation traffic from Read Keys.
 */
export async function activitySnapshot(ctx: AppContext, includeChats: boolean): Promise<ApiActivityProcess[]> {
  const prices = pricesOf(ctx);
  const snapshots = new Map((await ctx.runner.activeSnapshots()).map((snapshot) => [snapshot.attemptId, snapshot.snapshot]));
  const runs: ApiActivityProcess[] = await Promise.all((await ctx.attempts.listRunning()).map(async (run) => {
    const task = await ctx.tasks.get(run.taskId);
    const snapshot = snapshots.get(run.id) ?? null;
    return attemptProcessToApi({
      run,
      task,
      snapshot,
      workspaceName: await workspaceNameOf(ctx, task.workspaceId),
      trackerUrl: ctx.trackerManager.urlFor(task.workspaceId, task.trackerRef),
      contextWindow: contextWindowOf(ctx, task.model),
      cost: snapshot ? costOfUsages([snapshot.usage], prices) : null,
    });
  }));
  if (!includeChats) return runs;
  const chats: ApiActivityProcess[] = await Promise.all(ctx.conversationDriver.activeConversationIds().map(async (id) => {
    const convo = await ctx.conversations.get(id);
    const usage = parseUsage(convo.usage);
    return conversationProcessToApi({
      conversation: convo,
      title: convo.title ?? firstLineTitle(await ctx.conversations.firstTurnText(id)) ?? `Conversation #${id}`,
      workspaceName: await workspaceNameOf(ctx, convo.workspaceId),
      contextWindow: contextWindowOf(ctx, convo.model),
      cost: costOfUsages([usage], prices),
    });
  }));
  return [...runs, ...chats];
}

/** The Workspace's name for an at-rest workspaceId — every live process names its own Workspace (issue #52). */
async function workspaceNameOf(ctx: AppContext, workspaceId: number | null): Promise<string> {
  return (await ctx.workspaces.get(atRestWorkspaceId(workspaceId))).name;
}

/** A model's effective context window: config override, then the shipped
 * default (`DEFAULT_CONTEXT_WINDOWS`); null when neither knows the model — the
 * gauge then shows raw tokens, never a fabricated percentage (issue #52). */
function contextWindowOf(ctx: AppContext, model: string): number | null {
  return resolveContextWindow(model, ctx.settingsStore.getGlobal().modelInfo);
}

/**
 * A Conversation as the REST API and firehose both serve it — one format for
 * the SPA. Running Usage/Cost are derived on read (issue 12), the title falls
 * back to one derived from the first Turn (issue 15), and the context-window
 * / cache-TTL facts come from optional per-model config; honest degradation
 * when unconfigured (null, never a fake percentage).
 */
export async function conversationToApi(ctx: AppContext, conversation: ConversationRow): Promise<ApiConversation> {
  const config = ctx.settingsStore.getGlobal();
  const modelInfo = config.modelInfo[conversation.model] ?? config.modelInfo[conversation.model.replace(/-\d{8}$/, '')];
  const usage = parseUsage(conversation.usage);
  return conversationToApiDto(conversation, {
    title: conversation.title ?? deriveConversationTitle(await ctx.conversations.firstTurnText(conversation.id)),
    cost: costOfUsages([usage], pricesOf(ctx)),
    contextWindow: modelInfo?.contextWindow ?? null,
    cacheTtlSeconds: modelInfo?.cacheTtlSeconds ?? null,
  });
}
