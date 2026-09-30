import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, DeepPartial } from '../src/config.js';
import { connectFirehose, startServer, type TestServer, waitFor } from './helpers.js';

describe('Export failure surfacing (#738)', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-export-fail-'));
  const blocked = join(root, 'blocked');
  const received: Array<{ path: string; body: string }> = [];
  let sink: Server;
  let sinkUrl: string;
  let server: TestServer;

  beforeAll(async () => {
    writeFileSync(blocked, 'a file, not a directory');
    sink = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ path: req.url ?? '/', body });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
    sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
    server = await startServer(
      { defaults: { isolationMode: 'direct' }, export: { enabled: true, directory: { path: blocked } } } as DeepPartial<AppConfig>,
      { dataDir: join(root, 'data') },
    );
  });

  afterAll(async () => {
    await server?.close();
    sink?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the Task done, toasts every client, notifies channels and registers the retry job', async () => {
    await server.api('POST', '/api/channels', {
      name: 'export-alerts', type: 'webhook', config: { url: `${sinkUrl}/hook` }, events: ['export.failed'],
    });
    const { messages, close } = await connectFirehose(server);
    try {
      const task = await server.api('POST', '/api/tasks', { prompt: 'export fails', workingDir: root, isolationMode: 'direct' });
      await server.app.ctx.tasks.setState(task.body.id, 'working');
      expect((await server.api('POST', `/api/tasks/${task.body.id}/complete`)).status).toBe(200);

      const failed = await waitFor(async () => messages.find((m) => m.type === 'export_failed'));
      expect(failed).toMatchObject({
        type: 'export_failed',
        taskId: task.body.id,
        destination: 'directory',
        disposition: 'done',
        retry: 0,
        nextRetryAt: expect.any(String),
      });
      expect(typeof failed.error).toBe('string');
      expect((await server.app.ctx.tasks.get(task.body.id)).state).toBe('done');

      const delivery = await waitFor(async () => received.find((r) => r.path === '/hook'));
      expect(JSON.parse(delivery.body)).toMatchObject({
        event: 'export.failed',
        task: { id: task.body.id },
        export: { destination: 'directory', retry: 0 },
      });

      const jobs = await server.api('GET', '/api/scheduled-jobs');
      expect(jobs.body.jobs.some((job: { name: string }) => job.name === 'Export retry')).toBe(true);
    } finally {
      close();
    }
  });
});
