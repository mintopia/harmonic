import { afterEach, describe, expect, it } from 'vitest';
import { startServer, waitFor, type TestServer } from './helpers.js';

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
});
