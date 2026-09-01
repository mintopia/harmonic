import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startServer, stubHarness, captureRunEnv, type TestServer } from './helpers.js';
import type { Epic } from '../src/domain/epic-view.js';

describe('Epic read model operator surface (issue #167)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await server.close();
  });

  const ctx = () => server.app.ctx;
  const defaultWorkspaceId = async () => (await ctx().workspaces.list())[0]!.id;

  const epic = (over: Partial<Epic> = {}): Epic => ({
    ref: 42,
    title: 'Parallel Epic operator UI',
    kind: 'spec',
    state: 'open',
    description: '',
    createdAt: 0,
    updatedAt: null,
    baseBranch: null,
    dependsOn: [],
    members: [
      {
        ref: 43,
        title: 'Member one',
        taskId: 7,
        state: 'completed',
        escalated: false,
        mergeStatus: 'completed',
        ready: false,
      },
      { ref: 44, title: 'Member two', taskId: null, state: null, escalated: false, mergeStatus: 'pending', ready: true },
    ],
    ready: [44],
    integration: { branch: 'epic/42', exists: true, tip: 'a1b2c3d' },
    verification: { status: null },
    integrate: { inFlight: false, held: null },
    foldedCount: 1,
    memberCount: 2,
    ...over,
  });

  describe('GET /api/workspaces/:workspaceId/epics', () => {
    it('returns { epics } from TrackerPollerManager.listEpics on a 200', async () => {
      const list = [epic()];
      const spy = vi.spyOn(ctx().trackerManager, 'listEpics').mockResolvedValue(list);

      const res = await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ epics: list, total: list.length });
      expect(spy).toHaveBeenCalledWith((await defaultWorkspaceId()));
    });

    it('returns an empty list rather than erroring when no Epic is derived', async () => {
      vi.spyOn(ctx().trackerManager, 'listEpics').mockResolvedValue([]);
      const res = await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ epics: [], total: 0 });
    });

    it('404s when the Workspace does not exist', async () => {
      const res = await server.api('GET', '/api/workspaces/999999/epics');
      expect(res.status).toBe(404);
    });

    it('400s on a non-numeric workspaceId', async () => {
      expect((await server.api('GET', '/api/workspaces/abc/epics')).status).toBe(400);
    });
  });

  describe('GET /api/workspaces/:workspaceId/epics/:epicRef', () => {
    it('returns the Epic from TrackerPollerManager.epicDetail on a 200', async () => {
      const one = epic();
      const spy = vi.spyOn(ctx().trackerManager, 'epicDetail').mockResolvedValue(one);

      const res = await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics/42`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(one);
      expect(spy).toHaveBeenCalledWith((await defaultWorkspaceId()), 42);
    });

    it('404s when epicDetail resolves null (no such derived Epic)', async () => {
      vi.spyOn(ctx().trackerManager, 'epicDetail').mockResolvedValue(null);
      const res = await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics/42`);
      expect(res.status).toBe(404);
    });

    it('404s when the Workspace does not exist', async () => {
      const res = await server.api('GET', '/api/workspaces/999999/epics/42');
      expect(res.status).toBe(404);
    });

    it('400s on a non-numeric workspaceId or epicRef', async () => {
      expect((await server.api('GET', '/api/workspaces/abc/epics/42')).status).toBe(400);
      expect((await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics/xyz`)).status).toBe(400);
    });
  });

  describe('GET /api/workspaces/:workspaceId/epics/:epicRef/diff/files (ADR-0018, issue #441)', () => {
    it('parses TrackerPollerManager.epicDiff\'s raw unified diff into files, paginated', async () => {
      const raw = [
        'diff --git a/feature.txt b/feature.txt',
        'new file mode 100644',
        'index 0000000..1234567',
        '--- /dev/null',
        '+++ b/feature.txt',
        '@@ -0,0 +1 @@',
        '+added by the epic',
        '',
      ].join('\n');
      const spy = vi.spyOn(ctx().trackerManager, 'epicDiff').mockResolvedValue(raw);

      const res = await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics/42/diff/files`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.files).toHaveLength(1);
      expect(res.body.files[0]).toMatchObject({ path: 'feature.txt', status: 'A', additions: 1, deletions: 0 });
      expect(spy).toHaveBeenCalledWith((await defaultWorkspaceId()), 42);
    });

    it('returns an empty files list, not an error, when epicDiff resolves the empty string (branchless/no-op Epic)', async () => {
      vi.spyOn(ctx().trackerManager, 'epicDiff').mockResolvedValue('');
      const res = await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics/42/diff/files`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ files: [], total: 0 });
    });

    it('404s when the Workspace does not exist', async () => {
      const res = await server.api('GET', '/api/workspaces/999999/epics/42/diff/files');
      expect(res.status).toBe(404);
    });

    it('400s on a non-numeric workspaceId or epicRef', async () => {
      expect((await server.api('GET', '/api/workspaces/abc/epics/42/diff/files')).status).toBe(400);
      expect((await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics/xyz/diff/files`)).status).toBe(400);
    });
  });

  describe('operator-only gating', () => {
    it('denies an attempt-scoped Attempt Key on GET /api/workspaces/:id/epics', async () => {
      const { env } = await captureRunEnv(server, ['HARMONIC_API_KEY']);
      const token = env.HARMONIC_API_KEY as string;

      const res = await fetch(`${server.baseUrl}/api/workspaces/${(await defaultWorkspaceId())}/epics`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    });

    it('denies an attempt-scoped Attempt Key on GET /api/workspaces/:id/epics/:ref', async () => {
      const { env } = await captureRunEnv(server, ['HARMONIC_API_KEY']);
      const token = env.HARMONIC_API_KEY as string;

      const res = await fetch(`${server.baseUrl}/api/workspaces/${(await defaultWorkspaceId())}/epics/42`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    });

    it('denies a read-scoped key on GET /api/workspaces/:id/epics (operator required, not just read)', async () => {
      const { body } = await server.api('POST', '/api/keys', { name: 'viz', scope: 'read' });
      const res = await fetch(`${server.baseUrl}/api/workspaces/${(await defaultWorkspaceId())}/epics`, {
        headers: { authorization: `Bearer ${body.token}` },
      });
      expect(res.status).toBe(403);
    });

    it('denies a read-scoped key on GET /api/workspaces/:id/epics/:ref (operator required, not just read)', async () => {
      const { body } = await server.api('POST', '/api/keys', { name: 'viz', scope: 'read' });
      const res = await fetch(`${server.baseUrl}/api/workspaces/${(await defaultWorkspaceId())}/epics/42`, {
        headers: { authorization: `Bearer ${body.token}` },
      });
      expect(res.status).toBe(403);
    });
  });
});
