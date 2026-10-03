import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, type TestServer } from './helpers.js';

describe('Agent Messages on the Task timeline API', () => {
  let server: TestServer;
  let sender: number;
  let recipient: number;
  let attemptId: number;
  let workspaceId: number;

  const agentRows = async (taskId: number) => {
    const { body } = await server.api('GET', `/api/tasks/${taskId}/timeline`);
    return body.events.filter((e: any) => e.kind === 'agent-message').map((e: any) => e.data);
  };

  beforeAll(async () => {
    server = await startServer(stubHarness());
    sender = (await server.api('POST', '/api/tasks', { prompt: 'sender' })).body.id;
    recipient = (await server.api('POST', '/api/tasks', { prompt: 'recipient' })).body.id;
    attemptId = (await server.api('POST', `/api/tasks/${sender}/run`)).body.id;
    workspaceId = (await server.app.ctx.tasks.get(sender)).workspaceId!;
    const send = (text: string, recipients: any[], replyTo: string | null = null, threadId: string | null = null) =>
      server.app.ctx.agentMessages.create({ workspaceId, text, replyTo, threadId, senderTaskId: sender, senderAttemptId: attemptId, recipients });
    const root = await send('hello', [{ taskId: recipient, receipt: 'held' }]);
    await send('again', [{ taskId: recipient, receipt: 'delivered', deliveredAt: 1 }], root.id, root.threadId);
    await send('nope', [{ taskId: recipient, receipt: 'refused', reason: 'recipient is done' }]);
  });
  afterAll(async () => { await server.close(); });

  it('emits a sent row per recipient on the sender, carrying receipt, preview and Thread id, including the refusal', async () => {
    const rows = await agentRows(sender);
    expect(rows.map((r: any) => [r.direction, r.receipt, r.preview, r.peerTaskId, r.isReply])).toEqual([
      ['sent', 'held', 'hello', recipient, false],
      ['sent', 'delivered', 'again', recipient, true],
      ['sent', 'refused', 'nope', recipient, false],
    ]);
    expect(rows.map((r: any) => r.sendNumber)).toEqual([1, 2, 3]);
    expect(rows[1].threadId).toBe(rows[0].threadId);
    expect(rows[2].reason).toBe('recipient is done');
  });

  it('emits received rows on the recipient but hides the refused send', async () => {
    const rows = await agentRows(recipient);
    expect(rows.map((r: any) => [r.direction, r.receipt, r.preview, r.peerTaskId])).toEqual([
      ['received', 'held', 'hello', sender],
      ['received', 'delivered', 'again', sender],
    ]);
  });
});
