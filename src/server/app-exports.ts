import { TaskExporter } from '../archive/task-export.js';
import { computeGitProvenance } from '../archive/git-provenance.js';
import { Git } from '../execution/git.js';
import { pruneArchives, type ArchiveRetention } from '../archive/archive-retention.js';
import { workspaceSlug } from '../archive/task-archive.js';
import { resolveExportSettings } from '../archive/export-settings.js';
import type { TaskRow } from '../db/schema.js';
import type { EpicMergeEventStore } from '../domain/epic-merge-events.js';
import { forEachYielding } from '../reliability/yield.js';
import { epicAttemptTimelineToApi, taskToApi, ticketTimelineToApi } from './serialize.js';
import { orFallback } from '../error-handling.js';
import type { AppContext } from './app-context.js';

export function registerAppExports({
  ctx,
  dataDir,
  epicMergeEvents,
}: {
  ctx: AppContext;
  dataDir: string;
  epicMergeEvents: Pick<EpicMergeEventStore, 'append'>;
}): TaskExporter {
  const exporter = new TaskExporter({
    fireAndForget: ctx.fireAndForget,
    dataDir,
    archive: ctx.archive,
    version: ctx.runningVersion,
    settings: async (task) => {
      const workspace =
        task.workspaceId === null
          ? undefined
          : await ctx.workspaces.get(task.workspaceId);
      return resolveExportSettings(ctx.settingsStore.getGlobal(), workspace);
    },
    epicSettings: async (workspaceId) =>
      resolveExportSettings(ctx.settingsStore.getGlobal(), await ctx.workspaces.get(workspaceId)),
    epicSnapshot: async (workspaceId, epicRef) => {
      const [detail, stored, timeline, workspaceTasks] = await Promise.all([
        ctx.trackerManager.epicDetail(workspaceId, epicRef),
        ctx.tasks.listStoredEpics(workspaceId),
        epicAttemptTimelineToApi(ctx, { workspaceId, epicRef }),
        ctx.tasks.list({ workspaceId }),
      ]);
      const matching: (typeof stored)[number][] = [];
      await forEachYielding(stored, (candidate) => {
        if (matching.length === 0 && candidate.trackerRef === epicRef) matching.push(candidate);
      });
      const row = matching[0];
      const byRef = new Map<number, TaskRow>();
      await forEachYielding(workspaceTasks, (t) => {
        if (t.trackerRef != null) byRef.set(t.trackerRef, t);
      });
      const members: Array<{ ref: number; task: TaskRow | null }> = [];
      await forEachYielding(row?.memberRefs ?? [], (ref) => {
        members.push({ ref, task: byRef.get(ref) ?? null });
      });
      return {
        ticket: detail ?? { ref: epicRef, state: row?.state ?? null, mergeCommit: row?.mergeCommit ?? null },
        timeline: { events: detail?.timelineEvents ?? [], ...timeline },
        agentMessages: await ctx.agentMessages.presentedForTasks(
          workspaceId,
          members.flatMap((m) => (m.task ? [m.task.id] : [])),
        ),
        attemptCount: timeline.attempts.length,
        members,
      };
    },
    workspaceName: async (workspaceId) =>
      (await orFallback(() => ctx.workspaces.get(workspaceId), { op: 'export.workspaceName', context: { workspaceId } }, null))?.name ?? null,
    snapshot: async (task) => {
      const [ticket, timeline, taskAttempts] = await Promise.all([
        taskToApi(ctx, await ctx.tasks.withDeps(task)),
        ticketTimelineToApi(ctx, task.id),
        ctx.attempts.listForTask(task.id),
      ]);
      const attemptIds: number[] = [];
      await forEachYielding(taskAttempts, (attempt) => {
        attemptIds.push(attempt.id);
      });
      const [remoteUrl, currentBranch, facts] = await Promise.all([
        orFallback(() => Git.originUrl(task.workingDir), { op: 'export.snapshot.originUrl', level: 'warn', context: { taskId: task.id } }, null),
        orFallback(() => Git.symbolicBranch(task.workingDir), { op: 'export.snapshot.currentBranch', level: 'warn', context: { taskId: task.id } }, null),
        orFallback(() => ctx.attempts.listMergedFacts(attemptIds), { op: 'export.snapshot.mergedFacts', level: 'warn', context: { taskId: task.id } }, [] as unknown[]),
      ]);
      const agentMessages = task.workspaceId === null ? [] : await ctx.agentMessages.presentedForTask(task.workspaceId, task.id);
      return { ticket, timeline, agentMessages, attemptCount: taskAttempts.length, git: computeGitProvenance({ attempts: taskAttempts, facts, remoteUrl, taskBaseBranch: task.baseBranch, currentBranch }) };
    },
    recordEpicStep: async (workspaceId, epicRef, step) => {
      await epicMergeEvents.append(workspaceId, epicRef, step);
      ctx.bus.emit('epic_changed', { workspaceId, epicRef });
    },
    recordFact: async (taskId, payload) => {
      await ctx.taskEvents.appendEvent(taskId, payload);
      ctx.bus.emit('step_changed', { taskId });
    },
    onFailure: ({ owner, disposition, destination, error, retry, nextRetryAt }) => {
      const task = owner.kind === 'task' ? owner.task : undefined;
      const epicRef = owner.kind === 'epic' ? owner.epicRef : undefined;
      const workspaceId = task ? task.workspaceId : owner.kind === 'epic' ? owner.workspaceId : null;
      ctx.bus.emit('export_failed', { taskId: task?.id ?? null, epicRef: epicRef ?? null, workspaceId, trackerRef: task?.trackerRef ?? null, destination, disposition, error, retry, nextRetryAt });
      ctx.fireAndForget(
        () =>
          ctx.notifier.notify('export.failed', task, {
            workspaceId,
            export: { ...(epicRef === undefined ? {} : { epicRef }), destination, disposition, error, retry, nextRetryAt },
          }),
        { op: 'export.notifyFailure', level: 'warn', context: task ? { taskId: task.id } : { epicRef: epicRef! } },
      );
    },
  });
  ctx.scheduler.register({
    name: 'Archive retention',
    intervalMs: 60 * 60_000,
    run: async () => {
      const overrides = new Map<string, ArchiveRetention>();
      await forEachYielding(await ctx.workspaces.list(), (ws) => {
        overrides.set(workspaceSlug(ws.name, ws.id), { days: ws.archiveRetentionDays, maxTotalMB: ws.archiveRetentionMaxTotalMB });
      });
      await pruneArchives({
        dataDir,
        retention: () => ctx.settingsStore.getGlobal().archive.retain,
        workspaceRetention: (slug) => overrides.get(slug) ?? null,
        pendingExports: () => exporter.pendingOwnerKeys(),
        taskTerminalAt: async (taskId) => {
          const task = await orFallback(() => ctx.tasks.get(taskId), { op: 'archive.retention.task', context: { taskId } }, null);
          return task && (task.state === 'done' || task.state === 'cancelled') ? task.updatedAt : null;
        },
      });
    },
  });
  ctx.scheduler.register({ name: 'Export retry', intervalMs: 60_000, run: () => exporter.retryDue() });
  ctx.tasks.setBeforeDelete((task) => exporter.captureForDelete(task));
  ctx.bus.on('task_disposition', ({ task, disposition }) => exporter.trigger(task, disposition));
  ctx.bus.on('epic_integrated', ({ workspaceId, epicRef }) => {
    ctx.fireAndForget(() => ctx.archive.recordEpicDisposition(workspaceId, epicRef, 'done'), { op: 'archive.epicDisposition', level: 'warn', context: { workspaceId, epicRef } });
    exporter.triggerEpic(workspaceId, epicRef, 'done');
  });
  ctx.fireAndForget(() => exporter.sweepStaging(), { op: 'export.sweepStaging', level: 'warn' });
  return exporter;
}
