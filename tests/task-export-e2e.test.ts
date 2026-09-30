import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { epics, tasks, workspaces } from '../src/db/schema.js';
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

  it('exports an integrated Epic with its Members referenced', async () => {
    const { ctx } = okServer.app;
    const workspaceId = (await ctx.asyncDb.read((d) => d.select().from(workspaces).get()))!.id;
    const memberId = await driveToDone(okServer, root);
    await ctx.asyncDb.write((d) => d.update(tasks).set({ trackerRef: 31 }).where(eq(tasks.id, memberId)).run());
    await waitFor(async () => ((await exportFacts(okServer, memberId)).length > 0 ? true : undefined));
    await ctx.asyncDb.write((d) => d.insert(epics).values({ workspaceId, trackerRef: 30, kind: 'epic', state: 'open' } as typeof epics.$inferInsert).run());
    await ctx.tasks.markEpicIntegrated(workspaceId, 30, { mergeCommit: 'abc', memberRefs: [31] });
    ctx.bus.emit('epic_integrated', { workspaceId, epicRef: 30 });

    const slugDir = join(good, readdirSync(good)[0]!);
    const tarball = await waitFor(async () => readdirSync(slugDir).find((n) => n.startsWith('epic-30-done-')));
    const out = mkdtempSync(join(tmpdir(), 'harmonic-epic-e2e-extract-'));
    try {
      execFileSync('tar', ['-xzf', join(slugDir, tarball), '-C', out]);
      const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({ format: 'harmonic-epic-export', epicRef: 30 });
      expect(manifest.members).toHaveLength(1);
      expect(manifest.members[0]).toMatchObject({ ref: 31, taskId: memberId, status: 'done' });
      expect(manifest.members[0].export).toMatch(new RegExp(`^${memberId}-done-`));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
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
