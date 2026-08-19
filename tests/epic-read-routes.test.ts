import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import type { Epic } from '../src/domain/epic-view.js';

/**
 * The operator Epic read-model surface (issue #167, ADR-0026), over REST.
 * `TrackerPollerManager.listEpics`/`epicDetail` are exercised directly by
 * `epic-view.test.ts` (pure composer) and the manager's own tests; these
 * tests exercise the operator-facing plumbing around them — routing, param
 * parsing, the null→404 mapping, and the operator-only auth gate — spying on
 * the manager rather than standing up a real tracker loop.
 */
describe('Epic read model operator surface (issue #167)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await server.close();
  });

  const ctx = () => server.app.ctx;
  const defaultWorkspaceId = () => ctx().workspaces.list()[0]!.id;

  const epic = (over: Partial<Epic> = {}): Epic => ({
    ref: 42,
    title: 'Parallel Epic operator UI',
    kind: 'spec',
    members: [
      {
        ref: 43,
        title: 'Member one',
        taskId: 7,
        state: 'completed',
        escalated: false,
        landStatus: 'completed',
        ready: false,
      },
      { ref: 44, title: 'Member two', taskId: null, state: null, escalated: false, landStatus: 'pending', ready: true },
    ],
    ready: [44],
    integration: { branch: 'epic/42', exists: true, tip: 'a1b2c3d' },
    verification: { status: null },
    land: { inFlight: false, held: null },
    foldedCount: 1,
    memberCount: 2,
    ...over,
  });

  describe('GET /api/workspaces/:workspaceId/epics', () => {
    it('returns { epics } from TrackerPollerManager.listEpics on a 200', async () => {
      const list = [epic()];
      const spy = vi.spyOn(ctx().trackerManager, 'listEpics').mockResolvedValue(list);

      const res = await server.api('GET', `/api/workspaces/${defaultWorkspaceId()}/epics`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ epics: list });
      expect(spy).toHaveBeenCalledWith(defaultWorkspaceId());
    });

    it('returns an empty list rather than erroring when no Epic is derived', async () => {
      vi.spyOn(ctx().trackerManager, 'listEpics').mockResolvedValue([]);
      const res = await server.api('GET', `/api/workspaces/${defaultWorkspaceId()}/epics`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ epics: [] });
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

      const res = await server.api('GET', `/api/workspaces/${defaultWorkspaceId()}/epics/42`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(one);
      expect(spy).toHaveBeenCalledWith(defaultWorkspaceId(), 42);
    });

    it('404s when epicDetail resolves null (no such derived Epic)', async () => {
      vi.spyOn(ctx().trackerManager, 'epicDetail').mockResolvedValue(null);
      const res = await server.api('GET', `/api/workspaces/${defaultWorkspaceId()}/epics/42`);
      expect(res.status).toBe(404);
    });

    it('404s when the Workspace does not exist', async () => {
      const res = await server.api('GET', '/api/workspaces/999999/epics/42');
      expect(res.status).toBe(404);
    });

    it('400s on a non-numeric workspaceId or epicRef', async () => {
      expect((await server.api('GET', '/api/workspaces/abc/epics/42')).status).toBe(400);
      expect((await server.api('GET', `/api/workspaces/${defaultWorkspaceId()}/epics/xyz`)).status).toBe(400);
    });
  });

  describe('operator-only gating', () => {
    it('denies a run-scoped Run Key on GET /api/workspaces/:id/epics', async () => {
      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ echoEnv: ['HARMONIC_API_KEY'], exit: 'hang' }),
      });
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      const echo = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/runs/${started.body.id}/events`);
        return body.events.find((e: any) => e.payload?.content?.text?.startsWith('{'));
      });
      const token = JSON.parse(echo.payload.content.text).HARMONIC_API_KEY;

      const res = await fetch(`${server.baseUrl}/api/workspaces/${defaultWorkspaceId()}/epics`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    });

    it('denies a run-scoped Run Key on GET /api/workspaces/:id/epics/:ref', async () => {
      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ echoEnv: ['HARMONIC_API_KEY'], exit: 'hang' }),
      });
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      const echo = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/runs/${started.body.id}/events`);
        return body.events.find((e: any) => e.payload?.content?.text?.startsWith('{'));
      });
      const token = JSON.parse(echo.payload.content.text).HARMONIC_API_KEY;

      const res = await fetch(`${server.baseUrl}/api/workspaces/${defaultWorkspaceId()}/epics/42`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    });

    it('denies a read-scoped key on GET /api/workspaces/:id/epics (operator required, not just read)', async () => {
      const { body } = await server.api('POST', '/api/keys', { name: 'viz', scope: 'read' });
      const res = await fetch(`${server.baseUrl}/api/workspaces/${defaultWorkspaceId()}/epics`, {
        headers: { authorization: `Bearer ${body.token}` },
      });
      expect(res.status).toBe(403);
    });

    it('denies a read-scoped key on GET /api/workspaces/:id/epics/:ref (operator required, not just read)', async () => {
      const { body } = await server.api('POST', '/api/keys', { name: 'viz', scope: 'read' });
      const res = await fetch(`${server.baseUrl}/api/workspaces/${defaultWorkspaceId()}/epics/42`, {
        headers: { authorization: `Bearer ${body.token}` },
      });
      expect(res.status).toBe(403);
    });
  });
});
