import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { allWorkspaces } from './helpers.js';

describe('TaskService.orderedEligibleWork', () => {
  let directory: string;
  let db: AsyncDbHandle;
  let taskService: TaskService;
  let workspaceId: number;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'harmonic-ordered-work-'));
    db = await openAsyncDb(directory);
    taskService = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    workspaceId = (await allWorkspaces(db)())[0]!.id;
  });

  afterEach(async () => {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('orders agent-workable native priority, excluding an unlabelled mirror and blocked dependent', async () => {
    const low = await taskService.create({ prompt: 'native low', workspaceId, priority: 'low' });
    const high = await taskService.create({ prompt: 'native high', workspaceId, priority: 'high' });
    await taskService.upsertMirrored({
      trackerRef: 501,
      prompt: 'mirrored',
      workflow: 'implement',
      wayfinderType: null,
      drive: 'afk',
      mapRef: null,
      closed: false,
    }, workspaceId);
    const blocker = await taskService.create({ prompt: 'blocker', workspaceId });
    await taskService.create({ prompt: 'dependent', workspaceId, dependsOn: [blocker.id] });

    expect((await taskService.orderedEligibleWork(workspaceId)).map((task) => task.id)).toEqual([
      high.id,
      blocker.id,
      low.id,
    ]);
  });

  it('drops completed tasks and treats their dependencies as met', async () => {
    const blocker = await taskService.create({ prompt: 'blocker', workspaceId });
    const dependent = await taskService.create({ prompt: 'dependent', workspaceId, dependsOn: [blocker.id] });

    await taskService.setState(blocker.id, 'completed');

    expect((await taskService.orderedEligibleWork(workspaceId)).map((task) => task.id)).toEqual([dependent.id]);
  });
});
