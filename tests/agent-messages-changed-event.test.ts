import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AgentMessageStore } from '../src/domain/agent-messages.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

describe('agent_messages_changed notification', () => {
  let dataDir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let store: AgentMessageStore;
  let workspaceId: number;
  const changed: number[] = [];

  beforeEach(async () => {
    changed.length = 0;
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-am-evt-'));
    asyncDb = await openAsyncDb(dataDir);
    workspaceId = await seedWorkspace(asyncDb);
    const settingsStore = await makeSettingsStore(dataDir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    store = new AgentMessageStore(asyncDb, (id) => changed.push(id));
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('fires when a message is created and when a receipt changes', async () => {
    const a = await tasks.create({ prompt: 'a' });
    const b = await tasks.create({ prompt: 'b' });
    const row = await store.create({
      workspaceId,
      text: 'hi',
      replyTo: null,
      threadId: null,
      senderTaskId: a.id,
      senderAttemptId: 1,
      recipients: [{ taskId: b.id, receipt: 'queued' }],
    });
    expect(changed).toEqual([workspaceId]);

    await store.updateRecipient(row.id, b.id, { receipt: 'held' });
    expect(changed).toEqual([workspaceId, workspaceId]);

    await store.takeHeld(b.id);
    expect(changed).toHaveLength(3);

    await store.updateRecipient('missing', b.id, { receipt: 'held' });
    expect(changed).toHaveLength(3);
  });
});
