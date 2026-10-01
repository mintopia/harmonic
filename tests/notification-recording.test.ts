import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineConfig } from '../src/config.js';
import { type AsyncDbHandle, openAsyncDb } from '../src/db/async.js';
import type { TaskRow } from '../src/db/schema.js';
import { AttemptSettleCoordinator } from '../src/domain/attempt-settle.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { TaskService, type TaskNotification } from '../src/domain/tasks.js';
import { ChannelService } from '../src/notifications/channels.js';
import type { NotificationInput } from '../src/notifications/notification-store.js';
import { Notifier } from '../src/notifications/notifier.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

describe('notification recording', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let channels: ChannelService;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let notified: { event: TaskNotification; task: TaskRow }[];
  let failed: { task: TaskRow; reason: string }[];
  let settle: AttemptSettleCoordinator;
  let merged: TaskRow[];
  let mergeRecorded: NotificationInput[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-notif-rec-'));
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    const settingsStore = await makeSettingsStore(dir);
    channels = new ChannelService(asyncDb);
    notified = [];
    failed = [];
    merged = [];
    mergeRecorded = [];
    const mergeNotifier = new Notifier(channels, () => {}, async (input) => {
      mergeRecorded.push(input);
    });
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore), () => {}, (event, task) => {
      notified.push({ event, task });
    });
    attempts = new AttemptStore(asyncDb);
    settle = new AttemptSettleCoordinator(tasks, attempts, undefined, undefined, undefined, {
      onFailedAttemptRequeued: (task, reason) => {
        failed.push({ task, reason });
      },
      onTaskMerged: (task) => {
        merged.push(task);
        void mergeNotifier.recordMerged(task);
      },
    });
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function workingTask(prompt = 'Fix the flaky test\nmore detail') {
    const task = await tasks.create({ prompt, state: 'ready' });
    await tasks.setState(task.id, 'working');
    const run = await attempts.create(task.id);
    return { task: await tasks.get(task.id), run };
  }

  describe('Notifier recording', () => {
    it('records each stored event exactly once, even with no channels', async () => {
      const recorded: NotificationInput[] = [];
      const notifier = new Notifier(channels, () => {}, async (input) => {
        recorded.push(input);
      });
      const { task } = await workingTask();
      const escalated = { ...task, escalationReason: 'needs a human' } as TaskRow;

      await notifier.notify('task.escalated', escalated);
      await notifier.notify('task.done', task);
      await notifier.notify('task.failed', task, { reason: 'process died' });
      await notifier.notify('export.failed', task, { reason: 'disk full', destination: '/mnt/out' });

      const base = { workspaceId: task.workspaceId, taskId: task.id };
      expect(recorded).toEqual([
        { ...base, severity: 'escalation', title: `Task ${task.id} escalated — needs a human`, detail: 'Fix the flaky test' },
        { ...base, severity: 'failure', title: `Task ${task.id} failed — process died`, detail: 'Fix the flaky test' },
        { ...base, severity: 'export', title: `Export failed for Task ${task.id} — disk full`, detail: '/mnt/out' },
      ]);
    });

    it('records an Epic export failure with no Task', async () => {
      const recorded: NotificationInput[] = [];
      const notifier = new Notifier(channels, () => {}, async (input) => {
        recorded.push(input);
      });
      await notifier.notify('export.failed', undefined, {
        workspaceId: 3,
        export: { epicRef: 42, destination: 's3', disposition: 'done', error: 'AccessDenied', retry: 0, nextRetryAt: null },
      });
      expect(recorded).toEqual([{ workspaceId: 3, taskId: null, severity: 'export', title: 'Export failed for Epic #42 — AccessDenied', detail: 's3' }]);
    });

    it('omits the reason suffix when an escalation has none', async () => {
      const recorded: NotificationInput[] = [];
      const notifier = new Notifier(channels, () => {}, async (input) => {
        recorded.push(input);
      });
      const { task } = await workingTask();
      await notifier.notify('task.escalated', { ...task, escalationReason: null } as TaskRow);
      expect(recorded[0]?.title).toBe(`Task ${task.id} escalated`);
    });

    it('does not record non-stored events', async () => {
      const record = vi.fn(async () => undefined);
      const notifier = new Notifier(channels, () => {}, record);
      const { task } = await workingTask();
      for (const event of ['task.created', 'run.started'] as const) await notifier.notify(event, task);
      await notifier.notify('queue.idle');
      await notifier.notify('update.failed');
      expect(record).not.toHaveBeenCalled();
    });

    it('a throwing recorder is logged and never blocks channel delivery or the caller', async () => {
      const log = vi.fn();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
      try {
        await channels.create({ name: 'hook', type: 'webhook', config: { url: 'http://127.0.0.1:9/x' }, events: ['task.escalated'] });
        const notifier = new Notifier(channels, log, async () => {
          throw new Error('db down');
        });
        const { task } = await workingTask();
        await expect(notifier.notify('task.escalated', task)).resolves.toBeUndefined();
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        expect(log).toHaveBeenCalledWith(expect.stringContaining('db down'));
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('AttemptSettleCoordinator task failure', () => {
    it('failed + ready requeues and reports one Task failure with the reason', async () => {
      const { task, run } = await workingTask();
      await settle.settle(task, run, 'process-death', { runState: 'failed', taskAction: 'ready', reason: 'harness exited' });
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ reason: 'harness exited', task: { id: task.id, state: 'ready' } });
    });

    it('failed + escalate reports no Task failure; the escalation notifies exactly once', async () => {
      const { task, run } = await workingTask();
      await settle.settle(task, run, 'escalate', { runState: 'failed', taskAction: 'escalate', reason: 'gave up' });
      expect(failed).toHaveLength(0);
      expect(notified.filter((n) => n.event === 'task.escalated')).toHaveLength(1);
    });

    it('operator-cancel reports no Task failure', async () => {
      const { task, run } = await workingTask();
      await tasks.cancel(task.id);
      await settle.settle(await tasks.get(task.id), run, 'operator-cancel', { runState: 'failed', taskAction: 'ready', reason: 'cancelled' });
      expect(failed).toHaveLength(0);
    });

    it('a second racing settle reports nothing further', async () => {
      const { task, run } = await workingTask();
      const projection = { runState: 'failed', taskAction: 'ready', reason: 'boom' } as const;
      await settle.settle(task, run, 'failed', projection);
      await settle.settle(await tasks.get(task.id), run, 'failed', projection);
      expect(failed).toHaveLength(1);
    });

    it('does not report when the Task was no longer working', async () => {
      const { task, run } = await workingTask();
      await tasks.cancel(task.id);
      await settle.settle(await tasks.get(task.id), run, 'failed', { runState: 'failed', taskAction: 'ready', reason: 'late' });
      expect(failed).toHaveLength(0);
    });
  });

  describe('AttemptSettleCoordinator merge', () => {
    it('done + completed reports one merged Task and records one merge Notification', async () => {
      const { task, run } = await workingTask();
      await settle.settle(task, run, 'agent-finish/unresolved', { runState: 'completed', taskAction: 'done', reason: null });
      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject({ id: task.id, state: 'done' });
      await vi.waitFor(() => expect(mergeRecorded).toHaveLength(1));
      expect(mergeRecorded[0]).toEqual({
        workspaceId: task.workspaceId,
        taskId: task.id,
        severity: 'merge',
        title: `Task ${task.id} merged`,
        detail: 'Fix the flaky test',
      });
    });

    it('operator force-complete records no merge Notification', async () => {
      const notifier = new Notifier(channels, () => {}, async (input) => {
        mergeRecorded.push(input);
      });
      const { task } = await workingTask();
      const done = await tasks.complete(task.id);
      await notifier.notify('task.done', done);
      expect(merged).toHaveLength(0);
      expect(mergeRecorded).toHaveLength(0);
    });
  });

  describe('TaskService outcome notifications', () => {
    it('escalate() fires task.escalated exactly once and merge fires task.done exactly once', async () => {
      const { task } = await workingTask();
      await tasks.escalate(task.id, 'stuck');
      expect(notified.filter((n) => n.event === 'task.escalated')).toHaveLength(1);
      expect(notified.filter((n) => n.event === 'task.done')).toHaveLength(0);

      await tasks.setState(task.id, 'done');
      expect(notified.filter((n) => n.event === 'task.done')).toHaveLength(1);
      expect(notified.filter((n) => n.event === 'task.escalated')).toHaveLength(1);
    });
  });
});
