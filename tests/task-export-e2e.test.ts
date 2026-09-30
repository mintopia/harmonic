import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, DeepPartial } from '../src/config.js';
import { startServer, type TestServer, waitFor } from './helpers.js';

async function driveToDone(server: TestServer, workDir: string): Promise<number> {
  const task = await server.api('POST', '/api/tasks', { prompt: 'export on done', workingDir: workDir, isolationMode: 'direct' });
  await server.app.ctx.tasks.setState(task.body.id, 'working');
  const done = await server.api('POST', `/api/tasks/${task.body.id}/complete`);
  expect(done.status).toBe(200);
  expect((await server.app.ctx.tasks.get(task.body.id)).state).toBe('done');
  return task.body.id;
}

async function exportFacts(server: TestServer, taskId: number): Promise<Array<Record<string, unknown>>> {
  const events = await server.app.ctx.taskEvents.listEvents(taskId);
  return events.map((e) => e.payload as Record<string, unknown>).filter((p) => p.event === 'export');
}

describe('Export on done (#734)', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-export-e2e-'));
  const good = join(root, 'good');
  const blocked = join(root, 'blocked');
  let okServer: TestServer;
  let badServer: TestServer;

  const overrides = (path: string): DeepPartial<AppConfig> =>
    ({ defaults: { isolationMode: 'direct' }, export: { enabled: true, directory: { path } } }) as DeepPartial<AppConfig>;

  beforeAll(async () => {
    writeFileSync(blocked, 'a file, not a directory');
    okServer = await startServer(overrides(good), { dataDir: join(root, 'data-ok') });
    badServer = await startServer(overrides(blocked), { dataDir: join(root, 'data-bad') });
  });

  afterAll(async () => {
    await okServer?.close();
    await badServer?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('produces a tarball and an export Fact after the Task reaches done', async () => {
    const taskId = await driveToDone(okServer, root);
    const facts = await waitFor(async () => {
      const found = await exportFacts(okServer, taskId);
      return found.length > 0 ? found : undefined;
    });
    expect(facts[0]).toMatchObject({ status: 'succeeded', destination: 'directory', disposition: 'done' });
    const slugDirs = readdirSync(good);
    expect(slugDirs).toHaveLength(1);
    const files = readdirSync(join(good, slugDirs[0]!));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^${taskId}-done-\\d{8}T\\d{6}\\.\\d{3}Z\\.tar\\.gz$`));
  });

  it('leaves the transition intact when the destination is unwritable', async () => {
    const taskId = await driveToDone(badServer, root);
    const facts = await waitFor(async () => {
      const found = await exportFacts(badServer, taskId);
      return found.length > 0 ? found : undefined;
    });
    expect(facts[0]).toMatchObject({ status: 'failed', destination: 'directory' });
    expect((await badServer.app.ctx.tasks.get(taskId)).state).toBe('done');
    expect(existsSync(join(root, 'data-bad', 'archive', '.staging')) ? readdirSync(join(root, 'data-bad', 'archive', '.staging')) : []).toEqual([]);
    expect(existsSync(join(root, 'data-bad', 'archive'))).toBe(true);
  });

  it('does not fail the done transition when a task_disposition listener throws', async () => {
    okServer.app.ctx.bus.on('task_disposition', () => {
      throw new Error('listener boom');
    });
    const taskId = await driveToDone(okServer, root);
    expect((await okServer.app.ctx.tasks.get(taskId)).state).toBe('done');
  });
});
