import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';
import { trackerRef } from '../src/tracker/adapter.js';

describe('TaskService.orderedEligibleWork', () => {
  let directory: string;
  let db: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let taskService: TaskService;
  let workspaceId: number;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'harmonic-ordered-work-'));
    db = await openAsyncDb(directory);
    await seedWorkspace(db);
    settingsStore = await makeSettingsStore(directory);
    taskService = new TaskService(db, () => baselineConfig(), allWorkspaces(db, settingsStore));
    workspaceId = (await allWorkspaces(db, settingsStore)())[0]!.id;
  });

  afterEach(async () => {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('orders agent-workable native priority, including an opted-in mirror, excluding an unlabelled mirror and a blocked dependent', async () => {
    const low = await taskService.create({ prompt: 'native low', workspaceId, priority: 'low' });
    const high = await taskService.create({ prompt: 'native high', workspaceId, priority: 'high' });
    const mirrored = await taskService.upsertMirrored({
      trackerRef: trackerRef(501),
      prompt: 'mirrored',
      workflow: 'implement',
      wayfinderType: null,
      mapRef: null,
      closed: false,
      facts: { state: 'open', parent: null, blockedBy: [], labels: ['ready-for-agent'], title: 'mirrored', body: '', url: 'https://example.test/501', createdAt: '2026-08-01T00:00:00Z' },
    }, workspaceId);
    await taskService.upsertMirrored({ trackerRef: trackerRef(502), prompt: 'unlabelled mirror', workflow: 'implement', wayfinderType: null, mapRef: null, closed: false }, workspaceId);
    const blocker = await taskService.create({ prompt: 'blocker', workspaceId });
    await taskService.create({ prompt: 'dependent', workspaceId, dependsOn: [blocker.id] });

    expect((await taskService.orderedEligibleWork(workspaceId)).map((task) => task.id)).toEqual([
      high.id,
      mirrored.id,
      blocker.id,
      low.id,
    ]);
  });

  it('drops completed tasks and treats their dependencies as met', async () => {
    const blocker = await taskService.create({ prompt: 'blocker', workspaceId });
    const dependent = await taskService.create({ prompt: 'dependent', workspaceId, dependsOn: [blocker.id] });

    await taskService.setState(blocker.id, 'done');

    expect((await taskService.orderedEligibleWork(workspaceId)).map((task) => task.id)).toEqual([dependent.id]);
  });

  describe('Epic Hold', () => {
    const facts = (parent: ReturnType<typeof trackerRef> | null, blockedByRefs: number[], labels: string[] = []) => ({
      state: 'open' as const,
      parent,
      blockedBy: blockedByRefs.map((n) => ({ ref: trackerRef(n), title: `#${n}`, state: 'open' as const })),
      labels,
      title: 'ticket',
      body: '',
      url: 'https://example.test',
      createdAt: '2026-08-01T00:00:00Z',
    });

    async function seedEpics(blockers: Array<{ epic: number; blockedBy: number[] }>, extra: number[] = []): Promise<void> {
      const refs = [...new Set([...blockers.map((b) => b.epic), ...extra])];
      await taskService.syncTrackerContainers(
        workspaceId,
        refs.map((n) => ({
          trackerRef: trackerRef(n),
          facts: facts(null, blockers.find((b) => b.epic === n)?.blockedBy ?? [], ['epic']),
        })),
      );
      await taskService.syncEpics(workspaceId, refs.map((n) => ({ ref: trackerRef(n), kind: 'epic' as const })));
    }

    async function member(n: number, parent: number) {
      return taskService.upsertMirrored(
        {
          trackerRef: trackerRef(n),
          prompt: `member ${n}`,
          workflow: 'implement',
          wayfinderType: null,
          mapRef: null,
          closed: false,
          facts: facts(trackerRef(parent), [], ['ready-for-agent']),
        },
        workspaceId,
      );
    }

    const eligibleIds = async () => (await taskService.orderedEligibleWork(workspaceId)).map((task) => task.id);

    it('excludes a Member of a blocked Epic until the blocker Epic is integrated', async () => {
      await seedEpics([{ epic: 73, blockedBy: [71] }], [71]);
      const held = await member(101, 73);

      expect(await eligibleIds()).toEqual([]);
      const deps = await taskService.withDeps(held);
      expect(deps).toMatchObject({ agentWorkable: false, openBlockerCount: 1, epicBlockers: [{ ref: '71', kind: 'epic', heldEpic: '73' }] });
      expect((await taskService.listWithDeps({ workspaceId })).find((task) => task.id === held.id)).toMatchObject({
        openBlockerCount: 1,
        epicBlockers: [{ ref: '71', kind: 'epic', heldEpic: '73' }],
      });

      await taskService.markEpicIntegrated(workspaceId, trackerRef(71), { mergeCommit: null, memberRefs: [] });

      expect(await eligibleIds()).toEqual([held.id]);
      expect(await taskService.withDeps(held)).toMatchObject({ agentWorkable: true, openBlockerCount: 0, epicBlockers: [] });
    });

    it('keeps holding while the blocker Epic is closed but not integrated', async () => {
      await seedEpics([{ epic: 73, blockedBy: [71] }], [71]);
      await taskService.syncTrackerContainers(workspaceId, [
        { trackerRef: trackerRef(73), facts: facts(null, [71], ['epic']) },
        { trackerRef: trackerRef(71), facts: { ...facts(null, [], ['epic']), state: 'closed' } },
      ]);
      await member(101, 73);

      expect(await eligibleIds()).toEqual([]);
    });

    it('releases a Member held on a Task blocker once that Task is done', async () => {
      const blocker = await member(50, 90);
      await seedEpics([{ epic: 73, blockedBy: [50] }], [90]);
      const held = await member(101, 73);

      expect(await eligibleIds()).toEqual([blocker.id]);
      await taskService.setState(blocker.id, 'working');
      await taskService.setState(blocker.id, 'done');

      expect(await eligibleIds()).toEqual([held.id]);
    });

    it('persists Epic blockedBy idempotently and never projects it into Task edges', async () => {
      await seedEpics([{ epic: 73, blockedBy: [71] }], [71]);
      const held = await member(101, 73);
      await seedEpics([{ epic: 73, blockedBy: [71] }], [71]);

      expect((await taskService.listTrackerContainers(workspaceId)).find((row) => row.trackerRef === '73')?.trackerBlockedBy.map((b) => b.ref)).toEqual(['71']);
      expect((await taskService.withDeps(held)).dependsOn).toEqual([]);

      await seedEpics([{ epic: 73, blockedBy: [] }], [71]);
      expect(await eligibleIds()).toEqual([held.id]);
    });

    it('broadcasts held Members when a literal, spine, or Task blocker clears, and not unrelated Members', async () => {
      const changed: number[] = [];
      const tracked = new TaskService(db, () => baselineConfig(), allWorkspaces(db, settingsStore), (task) => void changed.push(task.id));
      await tracked.syncTrackerContainers(workspaceId, [
        { trackerRef: trackerRef(73), facts: facts(null, [71, 60, 50], ['epic']) },
        { trackerRef: trackerRef(71), facts: facts(null, [], ['epic']) },
        { trackerRef: trackerRef(60), facts: facts(null, [], ['epic']) },
        { trackerRef: trackerRef(61), facts: facts(trackerRef(60), [], ['epic']) },
        { trackerRef: trackerRef(80), facts: facts(null, [], ['epic']) },
      ]);
      await tracked.syncEpics(workspaceId, [71, 61, 80, 73].map((n) => ({ ref: trackerRef(n), kind: 'epic' as const })));
      const mk = (n: number, parent: number, labels = ['ready-for-agent']) =>
        tracked.upsertMirrored(
          { trackerRef: trackerRef(n), prompt: `m${n}`, workflow: 'implement', wayfinderType: null, mapRef: null, closed: false, facts: facts(trackerRef(parent), [], labels) },
          workspaceId,
        );
      const held = await mk(101, 73);
      const unrelated = await mk(102, 80);
      const blockerTask = await mk(50, 90);

      changed.length = 0;
      await tracked.markEpicIntegrated(workspaceId, trackerRef(71), { mergeCommit: null, memberRefs: [] });
      expect(changed).toContain(held.id);
      expect(changed).not.toContain(unrelated.id);

      changed.length = 0;
      await tracked.markEpicIntegrated(workspaceId, trackerRef(61), { mergeCommit: null, memberRefs: [] });
      expect(changed).toContain(held.id);

      changed.length = 0;
      await tracked.setState(blockerTask.id, 'done');
      expect(changed).toContain(held.id);
      expect(changed).not.toContain(unrelated.id);
    });

    it('reports whether an Epic chain has Epic-kind blockers', async () => {
      await seedEpics([{ epic: 73, blockedBy: [71] }], [71, 72]);

      expect(await taskService.epicHasEpicBlockers(workspaceId, trackerRef(73))).toBe(true);
      expect(await taskService.epicHasEpicBlockers(workspaceId, trackerRef(72))).toBe(false);
    });
  });
});
