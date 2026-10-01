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
      const stamped = JSON.parse(readFileSync(join(okServer.dataDir, 'archive', readdirSync(join(okServer.dataDir, 'archive')).find((n) => !n.startsWith('.'))!, 'epic-30', 'archive.json'), 'utf8'));
      expect(stamped.dispositions).toEqual([{ disposition: 'done', at: expect.stringMatching(/^\d{4}-/) }]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('records git provenance from a real repository in the exported manifest', async () => {
    const repo = join(root, 'provenance-repo');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-b', 'trunk', repo]);
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-m', 'first');
    git('remote', 'add', 'origin', 'https://someone:s3cret-token@example.com/owner/repo.git');
    const startCommit = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    git('add', '-A');
    git('commit', '-m', 'second');
    const endCommit = git('rev-parse', 'HEAD');

    const { ctx } = okServer.app;
    const created = await okServer.api('POST', '/api/tasks', { prompt: 'provenance', workingDir: repo, isolationMode: 'direct' });
    const taskId: number = created.body.id;
    const attempt = await ctx.attempts.create(taskId);
    await ctx.attempts.update(attempt.id, { startOid: startCommit, verifiedHeadOid: endCommit });
    await ctx.tasks.setState(taskId, 'working');
    expect((await okServer.api('POST', `/api/tasks/${taskId}/complete`)).status).toBe(200);

    const slugDir = join(good, readdirSync(good)[0]!);
    const tarball = await waitFor(async () => readdirSync(slugDir).find((n) => n.startsWith(`${taskId}-done-`)));
    const out = mkdtempSync(join(tmpdir(), 'harmonic-provenance-extract-'));
    try {
      execFileSync('tar', ['-xzf', join(slugDir, tarball), '-C', out]);
      const raw = readFileSync(join(out, 'manifest.json'), 'utf8');
      expect(raw).not.toContain('s3cret-token');
      const manifest = JSON.parse(raw);
      expect(manifest.formatVersion).toBe(2);
      expect(manifest.git).toEqual({
        remoteUrl: 'https://example.com/owner/repo.git',
        baseBranch: 'trunk',
        startCommit,
        endCommit,
        mergeCommit: null,
        attempts: [{ id: attempt.id, startCommit, endCommit }],
      });
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
    const staged = readdirSync(join(root, 'data-bad', 'archive', '.staging')).sort();
    expect(staged).toHaveLength(2);
    expect(staged[0]).toMatch(new RegExp(`^${taskId}-[0-9a-f]+\\.pending\\.json$`));
    expect(staged[1]).toBe(staged[0]!.replace(/\.pending\.json$/, '.tar.gz'));
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

describe('Export on cancelled and deleted (#735)', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-export-e2e735-'));
  const good = join(root, 'good');
  let server: TestServer;

  const names = (): string[] => {
    if (!existsSync(good)) return [];
    return readdirSync(good).flatMap((slug) => readdirSync(join(good, slug)).filter((n) => !n.startsWith('.')));
  };

  beforeAll(async () => {
    server = await startServer(
      { defaults: { isolationMode: 'direct' }, export: { enabled: true, directory: { path: good } } } as DeepPartial<AppConfig>,
      { dataDir: join(root, 'data') },
    );
  });

  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const create = async (prompt: string): Promise<number> =>
    (await server.api('POST', '/api/tasks', { prompt, workingDir: root, isolationMode: 'direct' })).body.id;

  it('exports a -cancelled- tarball when a Task is cancelled', async () => {
    const id = await create('cancel me');
    expect((await server.api('POST', `/api/tasks/${id}/cancel`)).status).toBe(200);
    const facts = await waitFor(async () => {
      const found = await exportFacts(server, id);
      return found.length > 0 ? found : undefined;
    });
    expect(facts[0]).toMatchObject({ disposition: 'cancelled', status: 'succeeded' });
    expect(names().filter((n) => n.startsWith(`${id}-cancelled-`))).toHaveLength(1);
  });

  it('exports each transition once and keeps the earlier tarball', async () => {
    const id = await create('cancel then uncancel then cancel');
    await server.app.ctx.tasks.cancel(id);
    await waitFor(async () => (names().some((n) => n.startsWith(`${id}-cancelled-`)) ? true : undefined));
    const first = names().filter((n) => n.startsWith(`${id}-cancelled-`));
    expect(first).toHaveLength(1);
    await server.app.ctx.tasks.uncancel(id);
    await new Promise((r) => setTimeout(r, 1100));
    await server.app.ctx.tasks.cancel(id);
    await waitFor(async () => (names().filter((n) => n.startsWith(`${id}-cancelled-`)).length === 2 ? true : undefined));
    expect(names().filter((n) => n.startsWith(`${id}-cancelled-`))).toEqual(expect.arrayContaining(first));
  });

  it('exports a -deleted- tarball with the pre-delete ticket for an escalated Task with Attempts', async () => {
    const id = await create('delete me after running');
    await server.app.ctx.tasks.setState(id, 'working');
    await server.app.ctx.attempts.create(id);
    await server.app.ctx.tasks.escalate(id, 'needs a human');
    const res = await server.api('DELETE', `/api/tasks/${id}`);
    expect(res.status).toBe(200);
    await waitFor(async () => (names().some((n) => n.startsWith(`${id}-deleted-`)) ? true : undefined));
    const file = names().find((n) => n.startsWith(`${id}-deleted-`))!;
    const out = mkdtempSync(join(root, 'extract-'));
    execFileSync('tar', ['-xzf', join(good, readdirSync(good)[0]!, file), '-C', out]);
    expect(readFileSync(join(out, 'ticket.json'), 'utf8')).toContain('delete me after running');
    expect(readFileSync(join(out, 'ticket.json'), 'utf8')).toContain('escalated');
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))).toMatchObject({ disposition: 'deleted', counts: { attempts: 1 } });
    await expect(server.app.ctx.tasks.get(id)).rejects.toThrow();
  });

  it('exports nothing when a Task that never ran is deleted', async () => {
    const id = await create('never ran');
    const before = names().length;
    expect((await server.api('DELETE', `/api/tasks/${id}`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(names().filter((n) => n.startsWith(`${id}-`))).toEqual([]);
    expect(names()).toHaveLength(before);
  });
});
