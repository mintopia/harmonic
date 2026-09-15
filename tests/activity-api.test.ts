import { afterEach, describe, expect, it } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

describe('Activity API Workspace scope (issue #600)', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('filters warm Conversations by Workspace while an omitted Workspace remains global', async () => {
    server = await startServer(stubHarness());
    const secondWorkspace = await server.api('POST', '/api/workspaces', {
      name: 'Second',
      workingDir: server.dataDir,
    });
    const first = await server.api('POST', '/api/conversations', {});
    const second = await server.api('POST', '/api/conversations', { workspaceId: secondWorkspace.body.id });

    for (const conversation of [first.body, second.body]) {
      await server.api('POST', `/api/conversations/${conversation.id}/turns`, {
        text: JSON.stringify({ updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ready' } }] }),
      });
      await waitFor(async () => server!.app.ctx.conversationDriver.isWarm(conversation.id) ? true : undefined);
    }

    const global = await server.api('GET', '/api/activity');
    const scoped = await server.api('GET', `/api/activity?workspaceId=${secondWorkspace.body.id}`);

    expect(global.body.processes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'chat', conversationId: first.body.id }),
      expect.objectContaining({ type: 'chat', conversationId: second.body.id }),
    ]));
    expect(scoped.body).toMatchObject({
      total: 1,
      processes: [expect.objectContaining({ type: 'chat', conversationId: second.body.id, workspaceId: secondWorkspace.body.id })],
    });
  });
});
