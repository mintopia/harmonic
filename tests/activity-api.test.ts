import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

describe('Activity API Workspace scope (issue #600)', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('filters processes by Workspace while an omitted Workspace remains global', async () => {
    server = await startServer(stubHarness());
    const firstWorkspace = (await server.api('GET', '/api/workspaces')).body.workspaces[0];
    const secondDir = join(server.dataDir, 'second-workspace');
    mkdirSync(secondDir);
    const secondWorkspace = await server.api('POST', '/api/workspaces', {
      name: 'Second',
      workingDir: secondDir,
    });
    const firstTask = await server.api('POST', '/api/tasks', { prompt: 'first task', workspaceId: firstWorkspace.id });
    const secondTask = await server.api('POST', '/api/tasks', { prompt: 'second task', workspaceId: secondWorkspace.body.id });
    const firstAttempt = await server.app.ctx.attempts.create(firstTask.body.id);
    const secondAttempt = await server.app.ctx.attempts.create(secondTask.body.id);
    await server.app.ctx.tasks.syncEpics(secondWorkspace.body.id, [{ ref: 625, kind: 'epic' }]);
    const epicAttempt = await server.app.ctx.attempts.createForEpic({ workspaceId: secondWorkspace.body.id, epicRef: 625 });
    const first = await server.api('POST', '/api/conversations', {});
    const second = await server.api('POST', '/api/conversations', { workspaceId: secondWorkspace.body.id });

    for (const conversation of [first.body, second.body]) {
      await server.api('POST', `/api/conversations/${conversation.id}/turns`, {
        text: JSON.stringify({ updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ready' } }] }),
      });
      await waitFor(async () => server!.app.ctx.conversationDriver.isWarm(conversation.id) ? true : undefined);
    }

    const global = await server.api('GET', '/api/activity');
    const firstScoped = await server.api('GET', `/api/activity?workspaceId=${firstWorkspace.id}`);
    const scoped = await server.api('GET', `/api/activity?workspaceId=${secondWorkspace.body.id}`);

    expect(global.body.processes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'attempt', attemptId: firstAttempt.id, workspaceId: firstWorkspace.id }),
      expect.objectContaining({ type: 'attempt', attemptId: secondAttempt.id, workspaceId: secondWorkspace.body.id }),
      expect.objectContaining({ type: 'attempt', attemptId: epicAttempt.id, workspaceId: secondWorkspace.body.id }),
      expect.objectContaining({ type: 'chat', conversationId: first.body.id }),
      expect.objectContaining({ type: 'chat', conversationId: second.body.id }),
    ]));
    expect(firstScoped.body.processes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'attempt', attemptId: firstAttempt.id, workspaceId: firstWorkspace.id }),
      expect.objectContaining({ type: 'chat', conversationId: first.body.id, workspaceId: firstWorkspace.id }),
    ]));
    expect(firstScoped.body.processes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ attemptId: secondAttempt.id }),
      expect.objectContaining({ attemptId: epicAttempt.id }),
      expect.objectContaining({ conversationId: second.body.id }),
    ]));
    expect(scoped.body).toMatchObject({
      total: 3,
      processes: expect.arrayContaining([
        expect.objectContaining({ type: 'attempt', attemptId: secondAttempt.id, workspaceId: secondWorkspace.body.id }),
        expect.objectContaining({ type: 'attempt', attemptId: epicAttempt.id, workspaceId: secondWorkspace.body.id }),
        expect.objectContaining({ type: 'chat', conversationId: second.body.id, workspaceId: secondWorkspace.body.id }),
      ]),
    });
    expect(scoped.body.processes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ attemptId: firstAttempt.id }),
      expect.objectContaining({ conversationId: first.body.id }),
    ]));
  });
});
