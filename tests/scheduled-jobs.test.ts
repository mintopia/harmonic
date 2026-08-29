import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedLocalMarkdownTicket, startServer, waitFor, type TestServer } from './helpers.js';

describe('Scheduled Job registry (ADR-0038)', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('persists an injected exemplar and serves the same snapshot over REST and the firehose', async () => {
    let runs = 0;
    server = await startServer(undefined, {
      scheduledJobRegistrations: [{ name: 'test exemplar', intervalMs: 200, run: async () => { runs += 1; } }],
    });
    const ws = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/ws?token=${server.sessionToken}`);
    const messages: unknown[] = [];
    ws.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket failed to open')));
    });

    const snapshot = await waitFor(async () => {
      const response = await server!.api('GET', '/api/scheduled-jobs');
      const job = response.body.jobs.find((candidate: { name: string }) => candidate.name === 'test exemplar');
      return job?.lastStatus === 'ok' ? response.body : undefined;
    });
    expect(runs).toBeGreaterThan(0);
    expect(snapshot.jobs.find((job: { name: string }) => job.name === 'test exemplar')).toMatchObject({
      name: 'test exemplar',
      lastStatus: 'ok',
      status: 'active',
      lastOperationSpanId: expect.any(String),
    });
    const eventCount = messages.length;
    server.app.ctx.bus.emit('scheduled_jobs', snapshot.jobs);
    const event = await waitFor(async () =>
      messages.slice(eventCount).find(
        (message): message is { type: string; jobs: unknown } =>
          typeof message === 'object' && message !== null && 'type' in message && message.type === 'scheduled-jobs',
      ),
    );
    expect(event.jobs).toEqual(snapshot.jobs);
    const readKey = await server.api('POST', '/api/keys', { name: 'scheduled-jobs', scope: 'read' });
    const readResponse = await fetch(`${server.baseUrl}/api/scheduled-jobs`, {
      headers: { authorization: `Bearer ${readKey.body.token}` },
    });
    expect(readResponse.status).toBe(200);
    ws.close();

    const dataDir = server.dataDir;
    await server.app.close();
    server = await startServer(undefined, {
      dataDir,
      scheduledJobRegistrations: [{ name: 'test exemplar', intervalMs: 60_000, run: async () => {}, enabled: () => false }],
    });
    const afterRestart = await server.api('GET', '/api/scheduled-jobs');
    const restored = afterRestart.body.jobs.find((job: { name: string }) => job.name === 'test exemplar');
    expect(restored).toMatchObject({ lastStatus: 'ok', status: 'disabled', nextRunAt: null });
    expect(restored.lastRunAt).toEqual(expect.any(Number));
  });

  it('registers global sweeps and keeps an unresolved Workspace tracker job disabled until its Workspace is deleted', async () => {
    server = await startServer();
    const initial = await server.api('GET', '/api/scheduled-jobs');
    expect(initial.body.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Epic reconcile', workspaceId: null }),
        expect.objectContaining({ name: 'Session retirement drain', workspaceId: null, intervalMs: 5 * 60_000 }),
        expect.objectContaining({ name: 'Worktree reconciliation', workspaceId: null, intervalMs: 30 * 60 * 1000 }),
      ]),
    );

    const workingDir = mkdtempSync(join(tmpdir(), 'harmonic-unresolved-tracker-'));
    try {
      const created = await server.api('POST', '/api/workspaces', {
        name: 'Unresolved tracker',
        workingDir,
        trackerEnabled: true,
        trackerPollIntervalSeconds: 37,
      });
      expect(created.status).toBe(201);

      const withWorkspace = await server.api('GET', '/api/scheduled-jobs');
      expect(withWorkspace.body.jobs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Tracker poll',
            workspaceId: created.body.id,
            intervalMs: 37_000,
            status: 'disabled',
            nextRunAt: null,
          }),
        ]),
      );

      expect((await server.api('DELETE', `/api/workspaces/${created.body.id}`)).status).toBe(204);
      const afterDelete = await server.api('GET', '/api/scheduled-jobs');
      expect(afterDelete.body.jobs.some((job: { workspaceId: number | null }) => job.workspaceId === created.body.id)).toBe(false);
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it('reclaims an idle Session through the retirement Scheduled Job without run activity', async () => {
    server = await startServer();
    const [workspace] = await server.app.ctx.workspaces.list();
    const session = await server.app.ctx.sessions.recordDispatch({
      harness: 'claude',
      harnessSessionId: 'idle-session',
      model: 'test-model',
      cwd: '/tmp/work',
      workspaceId: workspace!.id,
      mcpTemplates: [],
      capabilities: undefined,
      adapterVersion: 'claude@test',
      now: 0,
    });
    await server.app.ctx.sessions.markIdle(session.id, 0, 'retention-ttl', 0);

    await server.app.ctx.scheduler.runNow('Session retirement drain');

    expect((await server.app.ctx.sessions.get(session.id)).status).toBe('retired');
    const jobs = await server.api('GET', '/api/scheduled-jobs');
    expect(jobs.body.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Session retirement drain', lastStatus: 'ok', lastRunAt: expect.any(Number) }),
      ]),
    );
  });

  it('registers the metrics-summary reader as a Scheduler Job when the caller wires it in (issue #386)', async () => {
    let flushes = 0;
    server = await startServer(undefined, {
      metricsSummary: { intervalMs: 60_000, flush: async () => { flushes += 1; } },
    });
    await server.app.ctx.scheduler.runNow('Metrics summary');
    // The scheduler fires a just-registered Job immediately if it is already
    // due (`runIfDueOnStart`), so boot itself may have run this once already;
    // this only proves the explicit `runNow` reached the flush at least once.
    expect(flushes).toBeGreaterThan(0);
    const jobs = await server.api('GET', '/api/scheduled-jobs');
    expect(jobs.body.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Metrics summary', workspaceId: null, intervalMs: 60_000, lastStatus: 'ok', lastOperationSpanId: expect.any(String) }),
      ]),
    );
  });

  it('runs each resolvable Workspace tracker poll at that Workspace interval', async () => {
    server = await startServer();
    const workingDir = mkdtempSync(join(tmpdir(), 'harmonic-scheduled-tracker-'));
    try {
      mkdirSync(join(workingDir, 'docs/agents'), { recursive: true });
      writeFileSync(join(workingDir, 'docs/agents/issue-tracker.md'), '# Issue tracker: Local Markdown\nPath: tickets\n');
      seedLocalMarkdownTicket(workingDir, 1);
      const created = await server.api('POST', '/api/workspaces', {
        name: 'Scheduled tracker',
        workingDir,
        trackerEnabled: true,
        trackerPollIntervalSeconds: 41,
      });
      expect(created.status).toBe(201);

      const trackerJob = await waitFor(async () => {
        const jobs = (await server!.api('GET', '/api/scheduled-jobs')).body.jobs;
        return jobs.find((job: { name: string; workspaceId: number; lastStatus: string | null }) =>
          job.name === 'Tracker poll' && job.workspaceId === created.body.id && job.lastStatus === 'ok',
        );
      });
      expect(trackerJob).toMatchObject({ intervalMs: 41_000, status: 'active', lastStatus: 'ok' });
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });
});
