import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, DeepPartial } from '../src/config.js';
import { eq } from 'drizzle-orm';
import { epics, tasks, workspaces } from '../src/db/schema.js';
import { startServer, type TestServer } from './helpers.js';
import { trackerRef } from '../src/tracker/adapter.js';

const TOKEN = `ghp_${'a1B2c3D4e5F6'.repeat(3)}`;

async function finishedTask(server: TestServer, workDir: string, finish: 'complete' | 'cancel' = 'complete'): Promise<number> {
  const task = await server.api('POST', '/api/tasks', { prompt: 'manual export', workingDir: workDir, isolationMode: 'direct' });
  await server.app.ctx.tasks.setState(task.body.id, 'working');
  expect((await server.api('POST', `/api/tasks/${task.body.id}/${finish}`)).status).toBe(200);
  return task.body.id;
}

async function download(server: TestServer, taskId: number): Promise<{ status: number; headers: Headers; bytes: Buffer }> {
  const res = await fetch(`${server.baseUrl}/api/tasks/${taskId}/export/download`, { headers: { cookie: `harmonic_session=${server.sessionToken}` } });
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}

function extract(tarball: string, into: string): void {
  execFileSync('tar', ['-xzf', tarball, '-C', into]);
}

describe('Manual Export actions', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-export-manual-'));
  const out = join(root, 'out');
  const blocked = join(root, 'blocked');
  let server: TestServer;
  let bare: TestServer;
  let flaky: TestServer;

  const overrides = (path: string): DeepPartial<AppConfig> =>
    ({ defaults: { isolationMode: 'direct' }, export: { enabled: true, includeStates: ['deleted'], directory: { path } } }) as DeepPartial<AppConfig>;

  beforeAll(async () => {
    writeFileSync(blocked, 'a file, not a directory');
    server = await startServer(overrides(out), { dataDir: join(root, 'data') });
    bare = await startServer({ defaults: { isolationMode: 'direct' } } as DeepPartial<AppConfig>, { dataDir: join(root, 'data-bare') });
    flaky = await startServer(overrides(blocked), { dataDir: join(root, 'data-flaky') });
  });

  afterAll(async () => {
    await server?.close();
    await bare?.close();
    await flaky?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('reports no Export before one is attempted', async () => {
    const id = await finishedTask(server, root);
    const res = await server.api('GET', `/api/tasks/${id}/export`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exportable: true, latest: null, earlier: [] });
  });

  it('exports a pre-feature Task again as a partial Export regardless of includeStates, never overwriting', async () => {
    const id = await finishedTask(server, root);
    await server.app.ctx.asyncDb.write((d) => d.update(tasks).set({ archiveId: null }).where(eq(tasks.id, id)).run());
    const first = await server.api('POST', `/api/tasks/${id}/export`);
    expect(first.status).toBe(200);
    expect(first.body.outcomes).toEqual([{ destination: 'directory', status: 'succeeded', file: expect.stringContaining(`${id}-done-`), error: null }]);

    const status = await server.api('GET', `/api/tasks/${id}/export`);
    expect(status.body.latest).toMatchObject({
      name: expect.stringMatching(new RegExp(`^${id}-done-.*\\.tar\\.gz$`)),
      disposition: 'done',
      partial: true,
      bytes: expect.any(Number),
      destinations: [{ destination: 'directory', location: join(out, readdirSync(out)[0]!), status: 'succeeded', error: null, retry: null }],
    });

    const slugDir = join(out, readdirSync(out)[0]!);
    const tarball = readdirSync(slugDir).find((n) => n.startsWith(`${id}-done-`))!;
    const dest = mkdtempSync(join(root, 'x-'));
    extract(join(slugDir, tarball), dest);
    expect(JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8'))).toMatchObject({ taskId: id, partial: true });

    const second = await server.api('POST', `/api/tasks/${id}/export`);
    expect(second.status).toBe(200);
    const mine = readdirSync(slugDir).filter((n) => n.startsWith(`${id}-done-`));
    expect(mine).toHaveLength(2);
    expect(new Set(mine).size).toBe(2);
    const after = await server.api('GET', `/api/tasks/${id}/export`);
    expect(after.body.earlier).toHaveLength(1);
    expect(after.body.latest.name).not.toBe(after.body.earlier[0].name);
  });

  it('exports a cancelled Task with the cancelled disposition', async () => {
    const id = await finishedTask(server, root, 'cancel');
    const res = await server.api('POST', `/api/tasks/${id}/export`);
    expect(res.status).toBe(200);
    expect(res.body.export.latest.disposition).toBe('cancelled');
  });

  it('rejects unfinished and unknown Tasks', async () => {
    const task = await server.api('POST', '/api/tasks', { prompt: 'still open', workingDir: root, isolationMode: 'direct' });
    for (const [method, path] of [
      ['POST', `/api/tasks/${task.body.id}/export`],
      ['GET', `/api/tasks/${task.body.id}/export/download`],
    ] as const) {
      expect((await server.api(method, path)).status).toBe(409);
    }
    expect((await server.api('GET', `/api/tasks/${task.body.id}/export`)).body.exportable).toBe(false);
    expect((await server.api('GET', '/api/tasks/999999/export')).status).toBe(404);
    expect((await server.api('POST', '/api/tasks/999999/export')).status).toBe(404);
    expect((await server.anonApi('POST', `/api/tasks/${task.body.id}/export`)).status).toBe(401);
  });

  describe('Epic Export routes', () => {
    const seedEpic = async (srv: TestServer, ref: number, state: 'open' | 'integrated'): Promise<number> => {
      const { ctx } = srv.app;
      const workspaceId = (await ctx.asyncDb.read((d) => d.select().from(workspaces).get()))!.id;
      await ctx.asyncDb.write((d) => d.insert(epics).values({ workspaceId, trackerRef: trackerRef(ref), kind: 'epic', state: 'open' } as typeof epics.$inferInsert).run());
      if (state === 'integrated') await ctx.tasks.markEpicIntegrated(workspaceId, trackerRef(ref), { mergeCommit: 'abc', memberRefs: [] });
      return workspaceId;
    };
    const base = (workspaceId: number, ref: number): string => `/api/workspaces/${workspaceId}/epics/${ref}/export`;

    it('reports status, exports again to every Destination and streams a download for an integrated Epic', async () => {
      const ws = await seedEpic(server, 61, 'integrated');
      expect((await server.api('GET', base(ws, 61))).body).toEqual({ exportable: true, latest: null, earlier: [] });

      const again = await server.api('POST', base(ws, 61));
      expect(again.status).toBe(200);
      expect(again.body.outcomes).toEqual([{ destination: 'directory', status: 'succeeded', file: expect.stringContaining('epic-61-done-'), error: null }]);
      expect(again.body.export.latest).toMatchObject({ disposition: 'done', destinations: [{ destination: 'directory', status: 'succeeded' }] });

      const res = await fetch(`${server.baseUrl}${base(ws, 61)}/download`, { headers: { cookie: `harmonic_session=${server.sessionToken}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="epic-61-done-.*\.tar\.gz"$/);
      const file = join(root, 'epic-download.tar.gz');
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      const dest = mkdtempSync(join(root, 'edl-'));
      extract(file, dest);
      expect(JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8'))).toMatchObject({ format: 'harmonic-epic-export', epicRef: '61' });
      expect((await server.api('GET', base(ws, 61))).body.earlier).toEqual([]);
    });

    it('rejects an Epic that is not integrated, an unknown Epic and a missing Destination', async () => {
      const ws = await seedEpic(bare, 62, 'open');
      expect((await bare.api('GET', base(ws, 62))).body.exportable).toBe(false);
      expect((await bare.api('POST', base(ws, 62))).status).toBe(409);
      expect((await bare.api('GET', `${base(ws, 62)}/download`)).status).toBe(409);
      expect((await bare.api('POST', base(ws, 999))).status).toBe(404);
      await bare.app.ctx.tasks.markEpicIntegrated(ws, trackerRef(62), { mergeCommit: 'abc', memberRefs: [] });
      expect((await bare.api('POST', base(ws, 62))).status).toBe(409);
      expect((await bare.anonApi('POST', base(ws, 62))).status).toBe(401);
    });
  });

  it('answers 409 to Export again when no Destination is configured', async () => {
    const id = await finishedTask(bare, root);
    expect((await bare.api('POST', `/api/tasks/${id}/export`)).status).toBe(409);
  });

  it('streams a redacted tarball download with no Destination configured, and cleans up', async () => {
    const id = await finishedTask(bare, root);
    const task = await bare.app.ctx.tasks.get(id);
    const dir = await bare.app.ctx.archive.ensure(task);
    mkdirSync(join(dir, 'attempts', '1', 'implementation'), { recursive: true });
    writeFileSync(join(dir, 'attempts', '1', 'implementation', 'prompt.md'), `use ${TOKEN} to push\n`);
    writeFileSync(join(dir, 'operator-inputs.jsonl'), `${JSON.stringify({ text: `token ${TOKEN}` })}\n`);

    const res = await download(bare, id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    const disposition = res.headers.get('content-disposition')!;
    expect(disposition).toMatch(new RegExp(`^attachment; filename="${id}-done-.*\\.tar\\.gz"$`));
    expect(Number(res.headers.get('content-length'))).toBe(res.bytes.length);

    const file = join(root, 'downloaded.tar.gz');
    writeFileSync(file, res.bytes);
    const dest = mkdtempSync(join(root, 'dl-'));
    extract(file, dest);
    const leaking = readdirSync(dest, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && readFileSync(join(e.parentPath, e.name), 'utf8').includes(TOKEN))
      .map((e) => e.name);
    expect(leaking).toEqual([]);
    expect(readFileSync(join(dest, 'attempts', '1', 'implementation', 'prompt.md'), 'utf8')).toContain('[REDACTED');
    expect(JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')).redaction.applied).toBe(true);

    const staging = join(bare.dataDir, 'archive', '.staging');
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
    expect((await bare.api('GET', `/api/tasks/${id}/export`)).body.latest).toBeNull();
  });

  it('shows the failure with retry info, then a later Export again succeeds', async () => {
    const id = await finishedTask(flaky, root);
    const failed = await flaky.api('POST', `/api/tasks/${id}/export`);
    expect(failed.status).toBe(200);
    expect(failed.body.outcomes[0]).toMatchObject({ destination: 'directory', status: 'failed', file: null, error: expect.any(String) });

    const status = await flaky.api('GET', `/api/tasks/${id}/export`);
    const row = status.body.latest.destinations[0];
    expect(row).toMatchObject({ destination: 'directory', status: 'failed', error: expect.any(String) });
    expect(row.retry).toEqual({ count: 0, max: 3, nextRetryAt: expect.any(String), exhausted: false });
    expect(status.body.latest.name).toMatch(new RegExp(`^${id}-done-`));

    rmSync(blocked);
    const fixed = await flaky.api('POST', `/api/tasks/${id}/export`);
    expect(fixed.status).toBe(200);
    expect(fixed.body.outcomes[0]).toMatchObject({ status: 'succeeded' });
    expect(fixed.body.export.latest.destinations[0]).toMatchObject({ status: 'succeeded', retry: null, error: null });
    expect(fixed.body.export.earlier).toHaveLength(1);
    expect(fixed.body.export.earlier[0].destinations[0].status).toBe('failed');
  });
});
