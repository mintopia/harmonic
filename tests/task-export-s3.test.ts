import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { type AsyncDbHandle, openAsyncDb } from '../src/db/async.js';
import type { TaskRow } from '../src/db/schema.js';
import { TaskService } from '../src/domain/tasks.js';
import { resolveExportSettings } from '../src/archive/export-settings.js';
import { TaskArchive } from '../src/archive/task-archive.js';
import { TaskExporter } from '../src/archive/task-export.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';
import { emptyGitProvenance } from '../src/archive/git-provenance.js';
import { BackgroundWork } from '../src/error-handling.js';

const ACCESS = 'harmonicaccess';
const SECRET = 'harmonicsecretkey123';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', 'versity/versitygw:latest'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

interface S3Overrides {
  bucket?: string | null;
  prefix?: string;
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  forcePathStyle?: boolean;
}

describe.skipIf(!dockerAvailable())('TaskExporter S3 destination (#737)', () => {
  let container = '';
  let globalBucket = '';
  let overrideBucket = '';
  let seq = 0;
  let endpoint = '';
  let admin: S3Client;
  let dir: string;
  let dest: string;
  let asyncDb: AsyncDbHandle;
  let task: TaskRow;
  let archive: TaskArchive;
  let facts: Array<Record<string, unknown>>;

  beforeAll(async () => {
    const port = await freePort();
    container = execFileSync(
      'docker',
      ['run', '-d', '--rm', '-p', `127.0.0.1:${port}:7070`, '-e', `ROOT_ACCESS_KEY=${ACCESS}`, '-e', `ROOT_SECRET_KEY=${SECRET}`, 'versity/versitygw:latest', 'posix', '/tmp'],
      { encoding: 'utf8' },
    ).trim();
    endpoint = `http://127.0.0.1:${port}`;
    admin = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET } });
    for (let i = 0; ; i++) {
      try {
        await admin.send(new ListObjectsV2Command({ Bucket: 'probe' })).catch((err: { name?: string }) => {
          if (err.name === 'NoSuchBucket') return;
          throw err;
        });
        break;
      } catch (err) {
        if (i > 60) throw err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }, 60_000);

  afterAll(() => {
    admin?.destroy();
    if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  });

  beforeEach(async () => {
    seq++;
    globalBucket = `global-${seq}`;
    overrideBucket = `override-${seq}`;
    for (const b of [globalBucket, overrideBucket]) await admin.send(new CreateBucketCommand({ Bucket: b }));
    dir = mkdtempSync(join(tmpdir(), 'harmonic-s3-data-'));
    dest = mkdtempSync(join(tmpdir(), 'harmonic-s3-dest-'));
    facts = [];
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    const store = await makeSettingsStore(dir);
    const tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, store));
    task = await tasks.create({ prompt: 'export me', state: 'ready', workingDir: dir, isolationMode: 'direct' });
    archive = new TaskArchive({ dataDir: dir, ensureArchiveId: (id) => tasks.ensureArchiveId(id), workspaceName: async () => 'My Workspace' });
    const step = join(await archive.ensure(task), 'attempts', '1', 'implementation');
    mkdirSync(step, { recursive: true });
    writeFileSync(join(step, 'prompt.md'), 'the prompt');
  });

  afterEach(async () => {
    await asyncDb.close();
    for (const d of [dir, dest]) rmSync(d, { recursive: true, force: true });
  });

  function config(s3: S3Overrides, directory: string | null = dest): AppConfig {
    const base = baselineConfig();
    return {
      ...base,
      export: {
        ...base.export,
        enabled: true,
        directory: { ...base.export.directory, path: directory },
        s3: {
          ...base.export.s3,
          endpoint,
          region: 'us-east-1',
          bucket: globalBucket,
          forcePathStyle: true,
          accessKeyId: ACCESS,
          secretAccessKey: SECRET,
          ...s3,
        },
      },
    } as AppConfig;
  }

  const exporter = (cfg: AppConfig, workspace?: Parameters<typeof resolveExportSettings>[1], now?: () => Date): TaskExporter =>
    new TaskExporter({
      fireAndForget: new BackgroundWork().fireAndForget,
      dataDir: dir,
      archive,
      version: '9.9.9',
      ...(now ? { now } : {}),
      settings: async () => resolveExportSettings(cfg, workspace),
      epicSettings: async () => resolveExportSettings(cfg, workspace),
      epicSnapshot: async () => ({ ticket: {}, timeline: {}, attemptCount: 0, members: [] }),
      workspaceName: async () => 'My Workspace',
      snapshot: async () => ({ ticket: { title: 'T' }, timeline: {}, attemptCount: 1, git: emptyGitProvenance() }),
      recordEpicStep: async () => undefined,
      recordFact: async (_id, payload) => {
        facts.push(payload as Record<string, unknown>);
      },
    });

  async function keys(bucket: string): Promise<string[]> {
    const res = await admin.send(new ListObjectsV2Command({ Bucket: bucket }));
    return (res.Contents ?? []).map((o) => o.Key!).sort();
  }

  async function download(bucket: string, key: string): Promise<string> {
    const res = await admin.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const file = join(dir, 'downloaded.tar.gz');
    writeFileSync(file, await res.Body!.transformToByteArray());
    const out = mkdtempSync(join(tmpdir(), 'harmonic-s3-extract-'));
    execFileSync('tar', ['-xzf', file, '-C', out]);
    return out;
  }

  const archiveExports = async (): Promise<Array<Record<string, unknown>>> =>
    JSON.parse(readFileSync(join(await archive.ensure(task), 'archive.json'), 'utf8')).exports;

  it('delivers to directory and S3 with separate statuses, path-style, valid tar.gz', async () => {
    const outcomes = await exporter(config({ prefix: 'exports/' })).run(task, 'done');

    expect(outcomes?.map((o) => [o.destination, o.status])).toEqual([['directory', 'succeeded'], ['s3', 'succeeded']]);
    expect(readdirSync(join(dest, 'my-workspace'))).toHaveLength(1);
    const objects = await keys(globalBucket);
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatch(/^exports\/my-workspace\/\d+-done-\d{8}T\d{6}\.\d{3}Z\.tar\.gz$/);
    expect(outcomes![1]!.file).toBe(`s3://${globalBucket}/${objects[0]}`);
    expect(facts.map((f) => [f.destination, f.status])).toEqual([['directory', 'succeeded'], ['s3', 'succeeded']]);
    expect((await archiveExports()).map((e) => e.destination)).toEqual(['directory', 's3']);
    const out = await download(globalBucket, objects[0]!);
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).format).toBe('harmonic-task-export');
    rmSync(out, { recursive: true, force: true });
  });

  it('delivers an Epic Export to directory and S3 and retries a failed S3 upload', async () => {
    const epicHistory = (): Array<Record<string, unknown>> =>
      JSON.parse(readFileSync(join(dir, 'archive', 'my-workspace', 'epic-5', 'archive.json'), 'utf8')).exports;
    const outcomes = await exporter(config({ prefix: 'exports/' })).runEpic(1, 5, 'done');

    expect(outcomes?.map((o) => [o.destination, o.status])).toEqual([['directory', 'succeeded'], ['s3', 'succeeded']]);
    const objects = await keys(globalBucket);
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatch(/^exports\/my-workspace\/epic-5-done-\d{8}T\d{6}\.\d{3}Z\.tar\.gz$/);
    const out = await download(globalBucket, objects[0]!);
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).format).toBe('harmonic-epic-export');
    rmSync(out, { recursive: true, force: true });
    expect(epicHistory().map((e) => [e.destination, e.status])).toEqual([['directory', 'succeeded'], ['s3', 'succeeded']]);

    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    let healed = false;
    const failures: unknown[] = [];
    const sut = new TaskExporter({
      fireAndForget: new BackgroundWork().fireAndForget,
      dataDir: dir,
      archive,
      version: '9.9.9',
      now: () => new Date(clock),
      settings: async () => resolveExportSettings(config({}), undefined),
      epicSettings: async () => resolveExportSettings(healed ? config({ prefix: 'again/' }, null) : config({ prefix: 'again/', secretAccessKey: 'wrongwrongwrong' }, null), undefined),
      epicSnapshot: async () => ({ ticket: {}, timeline: {}, attemptCount: 0, members: [] }),
      workspaceName: async () => 'My Workspace',
      snapshot: async () => ({ ticket: {}, timeline: {}, attemptCount: 0, git: emptyGitProvenance() }),
      recordEpicStep: async () => undefined,
      recordFact: async () => undefined,
      onFailure: (f) => void failures.push(f),
    });
    expect((await sut.exportEpicAgain(1, 5))?.map((o) => [o.destination, o.status])).toEqual([['s3', 'failed']]);
    expect(failures).toHaveLength(1);
    expect((await keys(globalBucket)).filter((k) => k.startsWith('again/'))).toEqual([]);
    expect([...(await sut.pendingOwnerKeys())]).toEqual(['epic:1:5']);

    healed = true;
    clock += 6 * 60_000;
    await sut.retryDue();
    expect((await keys(globalBucket)).filter((k) => k.startsWith('again/'))).toHaveLength(1);
    expect((await sut.pendingOwnerKeys()).size).toBe(0);
    expect(epicHistory().at(-1)).toMatchObject({ destination: 's3', status: 'succeeded', retry: 1 });
  });

  it('sends a Workspace bucket override only to its own bucket', async () => {
    await exporter(config({}), { exportS3Bucket: overrideBucket }).run(task, 'done');

    expect(await keys(globalBucket)).toEqual([]);
    expect(await keys(overrideBucket)).toHaveLength(1);
  });

  it('records S3 failed with wrong explicit keys while the directory still succeeds', async () => {
    const outcomes = await exporter(config({ accessKeyId: 'wrong', secretAccessKey: 'wrongwrongwrong' })).run(task, 'done');

    expect(outcomes?.map((o) => [o.destination, o.status])).toEqual([['directory', 'succeeded'], ['s3', 'failed']]);
    const s3 = outcomes![1]!;
    expect(s3.status === 'failed' && s3.error).toBeTruthy();
    expect(readdirSync(join(dest, 'my-workspace'))).toHaveLength(1);
    expect(facts.map((f) => [f.destination, f.status])).toEqual([['directory', 'succeeded'], ['s3', 'failed']]);
    expect(await keys(globalBucket)).toEqual([]);
  });

  it('uses the AWS default credential chain when no explicit keys are set', async () => {
    const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
    process.env.AWS_ACCESS_KEY_ID = ACCESS;
    process.env.AWS_SECRET_ACCESS_KEY = SECRET;
    try {
      const outcomes = await exporter(config({ accessKeyId: null, secretAccessKey: null }, null)).run(task, 'done');
      expect(outcomes?.map((o) => [o.destination, o.status])).toEqual([['s3', 'succeeded']]);
      expect(await keys(globalBucket)).toHaveLength(1);
    } finally {
      if (saved.id === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = saved.id;
      if (saved.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
    }
  });

  it('never overwrites an existing object', async () => {
    const at = new Date('2026-01-02T03:04:05.678Z');
    const sut = exporter(config({}), undefined, () => at);
    await sut.run(task, 'done');
    await sut.run(task, 'done');

    const objects = await keys(globalBucket);
    expect(objects).toHaveLength(2);
    expect(objects.some((k) => k.endsWith('-1.tar.gz'))).toBe(true);
  });
});
