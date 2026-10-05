import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { startServer, stubHarness, type TestServer } from './helpers.js';
import type { AgentMessageRecipient } from '../src/db/schema.js';

describe('agent message recipient index', () => {
  let server: TestServer;
  let dataDir = '';

  afterEach(async () => {
    await server?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
  });

  async function boot() {
    dataDir ||= mkdtempSync(join(tmpdir(), 'am-index-'));
    server = await startServer(stubHarness(), { dataDir });
  }

  async function seed(recipients: AgentMessageRecipient[]) {
    const created = await server.api('POST', '/api/tasks', { prompt: 'sender' });
    const task = await server.app.ctx.tasks.get(created.body.id);
    const started = await server.api('POST', `/api/tasks/${task.id}/run`);
    const row = await server.app.ctx.agentMessages.create({
      workspaceId: task.workspaceId!,
      text: 'hello',
      replyTo: null,
      threadId: null,
      senderTaskId: task.id,
      senderAttemptId: started.body.id,
      recipients,
    });
    return { row, workspaceId: task.workspaceId! };
  }

  const plan = async (query: ReturnType<typeof sql>) =>
    (await server.app.ctx.asyncDb.read((d) => d.all<{ detail: string }>(query))).map((r) => r.detail).join('\n');

  it('searches the recipient index instead of scanning agent_messages JSON', async () => {
    await boot();
    const detail = await plan(
      sql`explain query plan select * from agent_messages where id in (select message_id from agent_message_recipients where task_id = 7 and receipt = 'held')`,
    );
    expect(detail).toMatch(/SEARCH .*agent_message_recipients.* USING (COVERING )?INDEX/);
    expect(detail).not.toMatch(/json_each/);
  });

  it('keeps the index in step with receipt changes', async () => {
    await boot();
    const { row } = await seed([{ taskId: 9001, receipt: 'held' }]);
    const store = server.app.ctx.agentMessages;
    expect((await store.listHeld(9001)).map((m) => m.id)).toEqual([row.id]);
    await store.markDelivered([row], 9001);
    expect(await store.listHeld(9001)).toEqual([]);
    await store.updateRecipient(row.id, 9001, { receipt: 'held' });
    expect((await store.listHeld(9001)).map((m) => m.id)).toEqual([row.id]);
  });

  it('backfills the index for messages stored before it existed', async () => {
    await boot();
    const { row } = await seed([{ taskId: 9002, receipt: 'held' }]);
    await server.app.ctx.asyncDb.write((d) => d.run(sql`delete from agent_message_recipients`));
    await server.app.close();
    await boot();
    expect((await server.app.ctx.agentMessages.listHeld(9002)).map((m) => m.id)).toEqual([row.id]);
  });
});
