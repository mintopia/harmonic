import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

describe('TaskService.orderedEligibleWork', () => {
  let directory: string;
  let db: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let taskService: TaskService;
  let workspaceId: number;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'harmonic-ordered-work-'));
    db = await openAsyncDb(directory);
    settingsStore = await makeSettingsStore(directory);
    taskService = new TaskService(db, () => defaultConfig(), allWorkspaces(db, settingsStore));
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
      trackerRef: 501,
      prompt: 'mirrored',
      workflow: 'implement',
      wayfinderType: null,
      mapRef: null,
      closed: false,
      facts: { state: 'open', parent: null, blockedBy: [], labels: ['ready-for-agent'], title: 'mirrored', body: '', url: 'https://example.test/501', createdAt: '2026-08-01T00:00:00Z' },
    }, workspaceId);
    await taskService.upsertMirrored({ trackerRef: 502, prompt: 'unlabelled mirror', workflow: 'implement', wayfinderType: null, mapRef: null, closed: false }, workspaceId);
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
});
