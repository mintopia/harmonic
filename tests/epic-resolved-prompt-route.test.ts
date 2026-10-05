import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackerRef } from '../src/tracker/adapter.js';
import { seedWorkspace, startServer, type TestServer } from './helpers.js';

describe('Epic resolved prompts', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-epic-resolved-prompt-'));
  const epicRef = trackerRef(31);
  let server: TestServer;
  let workspaceId: number;
  const locator = 'resolution/epic-refresh-1/prompt.md';

  const url = (query: string) => `${server.baseUrl}/api/workspaces/${workspaceId}/epics/${epicRef}/resolved-prompt?${query}`;
  const get = (query: string) => fetch(url(query), { headers: { cookie: `harmonic_session=${server.sessionToken}` } });

  beforeAll(async () => {
    server = await startServer({}, { dataDir: join(root, 'data') });
    workspaceId = await seedWorkspace(server.app.ctx.asyncDb, root);
    await server.app.ctx.tasks.syncEpics(workspaceId, [{ ref: epicRef, kind: 'epic' }]);
    await server.app.ctx.archive.appendResolutionPrompt({ workspaceId, epicRef }, 1, 'epic-refresh', 1, 'first');
    await server.app.ctx.archive.appendResolutionPrompt({ workspaceId, epicRef }, 1, 'epic-refresh', 1, 'second\n\nbody');
  });

  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves an Epic prompt archived under Attempt 1 with no Attempt row, whole or by index', async () => {
    const whole = await get(`attempt=1&locator=${encodeURIComponent(locator)}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toContain('text/plain');
    expect(await whole.text()).toBe('first\n\n---\n\nsecond\n\nbody');
    expect(await (await get(`attempt=1&locator=${encodeURIComponent(locator)}&index=1`)).text()).toBe('second\n\nbody');
  });

  it('404s for an absent prompt, a wrong attempt, an out-of-range index, and a traversal', async () => {
    expect((await get(`attempt=2&locator=${encodeURIComponent(locator)}`)).status).toBe(404);
    expect((await get(`attempt=1&locator=${encodeURIComponent(locator)}&index=5`)).status).toBe(404);
    expect((await get(`attempt=1&locator=${encodeURIComponent('resolution/none/prompt.md')}`)).status).toBe(404);
    expect((await get(`attempt=1&locator=${encodeURIComponent('../../../../prompt.md')}`)).status).toBe(404);
  });

  it('lists an Epic Attempt\'s resolver prompts from its lifecycle events', async () => {
    const run = await server.app.ctx.attempts.createForEpic({ workspaceId, epicRef });
    await server.app.ctx.attempts.appendEvent(run.id, { type: 'lifecycle', payload: { event: 'epic-resolve', kind: 'refresh', locator, promptIndex: 0 } });
    await server.app.ctx.attempts.appendEvent(run.id, { type: 'lifecycle', payload: { event: 'merge-conflict-resolve', turn: 1, locator: 'resolution/epic-conflict-1/prompt.md', promptIndex: 0 } });
    await server.app.ctx.attempts.appendEvent(run.id, { type: 'lifecycle', payload: { event: 'merged' } });
    const { body } = await server.api('GET', `/api/workspaces/${workspaceId}/epics/${epicRef}/attempts`);
    expect(body.attempts[0].resolverPrompts.map((p: { kind: string; locator: string; promptIndex: number }) => [p.kind, p.locator, p.promptIndex])).toEqual([
      ['refresh', locator, 0],
      ['merge-conflict', 'resolution/epic-conflict-1/prompt.md', 0],
    ]);
  });
});
