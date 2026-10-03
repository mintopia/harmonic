import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { agentMessages } from '../src/db/schema.js';
import { baselineConfig } from '../src/config.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { TaskService } from '../src/domain/tasks.js';
import { AgentMessageStore } from '../src/domain/agent-messages.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

describe('Agent Message deletion rules (#763)', () => {
  let dataDir: string;
  let asyncDb: AsyncDbHandle;
  let workspaces: WorkspaceService;
  let tasks: TaskService;
  let store: AgentMessageStore;
  let workspaceId: number;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-am-del-'));
    asyncDb = await openAsyncDb(dataDir);
    workspaceId = await seedWorkspace(asyncDb);
    const settingsStore = await makeSettingsStore(dataDir);
    workspaces = new WorkspaceService(asyncDb, settingsStore);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    store = new AgentMessageStore(asyncDb);
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const send = (senderTaskId: number, recipientIds: number[], threadId: string | null = null) =>
    store.create({
      workspaceId,
      text: 'hello',
      replyTo: null,
      threadId,
      senderTaskId,
      senderAttemptId: 1,
      recipients: recipientIds.map((taskId) => ({ taskId, receipt: 'queued' as const })),
    });

  it('deletes a Workspace together with its Agent Messages', async () => {
    const a = await tasks.create({ prompt: 'a' });
    const b = await tasks.create({ prompt: 'b' });
    await send(a.id, [b.id]);
    expect(await asyncDb.read((d) => d.select().from(agentMessages).all())).toHaveLength(1);

    await workspaces.delete(workspaceId);

    expect(await asyncDb.read((d) => d.select().from(agentMessages).all())).toHaveLength(0);
  });

  it('keeps the Thread when a participant Task is deleted and marks that side deleted', async () => {
    const a = await tasks.create({ prompt: 'a' });
    const b = await tasks.create({ prompt: 'b' });
    const root = await send(a.id, [b.id]);
    await send(b.id, [a.id], root.threadId);

    await tasks.delete(b.id);

    const seen = await store.presentedForTask(workspaceId, a.id);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ senderTaskId: a.id, senderDeleted: false, recipients: [{ taskId: b.id, deleted: true }] });
    expect(seen[1]).toMatchObject({ senderTaskId: b.id, senderDeleted: true, recipients: [{ taskId: a.id, deleted: false }] });
    expect(new Set(seen.map((m) => m.threadId))).toEqual(new Set([root.threadId]));
  });
});
