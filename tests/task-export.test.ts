import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { type AsyncDbHandle, openAsyncDb } from '../src/db/async.js';
import type { TaskRow } from '../src/db/schema.js';
import { TaskService } from '../src/domain/tasks.js';
import { resolveExportSettings } from '../src/archive/export-settings.js';
import { TaskArchive } from '../src/archive/task-archive.js';
import { TaskExporter, type TaskExporterDeps } from '../src/archive/task-export.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

const TARBALL = /^(\d+)-(\d+-)?done-\d{8}T\d{6}\.\d{3}Z(-\d+)?\.tar\.gz$/;

function globalWith(path: string | null, enabled = true): AppConfig {
  const config = baselineConfig();
  return { ...config, export: { ...config.export, enabled, directory: { ...config.export.directory, path } } };
}

function extract(tarball: string): string {
  const out = mkdtempSync(join(tmpdir(), 'harmonic-export-extract-'));
  execFileSync('tar', ['-xzf', tarball, '-C', out]);
  return out;
}

function listAll(root: string, rel = ''): string[] {
  return readdirSync(join(root, rel), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listAll(root, join(rel, e.name)) : [join(rel, e.name)]))
    .sort();
}

describe('TaskExporter (#734)', () => {
  let dir: string;
  let dest: string;
  let asyncDb: AsyncDbHandle;
  let task: TaskRow;
  let archive: TaskArchive;
  let facts: Array<{ taskId: number; payload: Record<string, unknown> }>;
  let settingsFor: () => ReturnType<typeof resolveExportSettings>;

  const exporter = (overrides: Partial<TaskExporterDeps> = {}): TaskExporter =>
    new TaskExporter({
      dataDir: dir,
      archive,
      version: '9.9.9',
      settings: async () => settingsFor(),
      workspaceName: async () => 'My Workspace',
      snapshot: async () => ({ ticket: { title: 'Ticket title', id: task.id }, timeline: { events: [{ kind: 'fact' }] }, attemptCount: 1 }),
      recordFact: async (taskId, payload) => {
        facts.push({ taskId, payload: payload as Record<string, unknown> });
      },
      ...overrides,
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-export-data-'));
    dest = mkdtempSync(join(tmpdir(), 'harmonic-export-dest-'));
    facts = [];
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    const settingsStore = await makeSettingsStore(dir);
    const tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    task = await tasks.create({ prompt: 'export me', state: 'ready', workingDir: dir, isolationMode: 'direct' });
    archive = new TaskArchive({ dataDir: dir, ensureArchiveId: (id) => tasks.ensureArchiveId(id), workspaceName: async () => 'My Workspace' });
    const archiveDir = await archive.ensure(task);
    const step = join(archiveDir, 'attempts', '1', 'implementation');
    mkdirSync(join(step, 'native'), { recursive: true });
    writeFileSync(join(step, 'prompt.md'), 'the prompt');
    writeFileSync(join(step, 'acp.jsonl'), '{"ts":1}\n');
    writeFileSync(join(step, 'native', 'x.jsonl'), 'native\n');
    writeFileSync(join(archiveDir, 'operator-inputs.jsonl'), '{"text":"one"}\nnot json\n{"text":"two"}\n');
    settingsFor = () => resolveExportSettings(globalWith(dest), undefined);
  });

  afterEach(async () => {
    await asyncDb.close();
    for (const d of [dir, dest]) {
      try {
        chmodSync(d, 0o700);
      } catch {
        continue;
      }
      rmSync(d, { recursive: true, force: true });
    }
  });

  const tarballs = (): string[] => {
    const slugDir = join(dest, 'my-workspace');
    return existsSync(slugDir) ? readdirSync(slugDir).filter((n) => !n.startsWith('.')) : [];
  };
  const staging = (): string[] => {
    const s = join(dir, 'archive', '.staging');
    return existsSync(s) ? readdirSync(s) : [];
  };

  it('writes one tarball with the Archive files and top-level documents', async () => {
    const outcome = await exporter().run(task, 'done');

    expect(outcome?.status).toBe('succeeded');
    const names = tarballs();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(TARBALL);
    expect(names[0]!.startsWith(`${task.id}-`)).toBe(true);
    expect(readdirSync(join(dest, 'my-workspace'))).toEqual(names);
    expect(staging()).toEqual([]);

    const out = extract(join(dest, 'my-workspace', names[0]!));
    try {
      expect(listAll(out)).toEqual([
        'README.md',
        'archive.json',
        'attempts/1/implementation/acp.jsonl',
        'attempts/1/implementation/native/x.jsonl',
        'attempts/1/implementation/prompt.md',
        'manifest.json',
        'operator-inputs.json',
        'ticket.json',
        'timeline.json',
      ]);
      expect(readFileSync(join(out, 'attempts/1/implementation/prompt.md'), 'utf8')).toBe('the prompt');
      expect(readFileSync(join(out, 'attempts/1/implementation/native/x.jsonl'), 'utf8')).toBe('native\n');
      expect(JSON.parse(readFileSync(join(out, 'operator-inputs.json'), 'utf8'))).toEqual([{ text: 'one' }, { text: 'two' }]);
      expect(JSON.parse(readFileSync(join(out, 'ticket.json'), 'utf8'))).toEqual({ title: 'Ticket title', id: task.id });
      expect(JSON.parse(readFileSync(join(out, 'timeline.json'), 'utf8'))).toEqual({ events: [{ kind: 'fact' }] });
      const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({
        formatVersion: 1,
        harmonicVersion: '9.9.9',
        taskId: task.id,
        workspace: 'My Workspace',
        disposition: 'done',
        redaction: { applied: false, matches: {} },
        partial: false,
      });
      expect(typeof manifest.format).toBe('string');
      expect(Number.isNaN(Date.parse(manifest.exportedAt))).toBe(false);
      expect(readFileSync(join(out, 'README.md'), 'utf8')).toContain('Ticket title');
      expect(JSON.parse(readFileSync(join(out, 'archive.json'), 'utf8')).taskId).toBe(task.id);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('marks the manifest partial when Attempts exist but the Archive has none', async () => {
    rmSync(join(dir, 'archive'), { recursive: true, force: true });
    const fresh = new TaskArchive({ dataDir: dir, ensureArchiveId: async () => task.archiveId ?? 'a', workspaceName: async () => 'My Workspace' });
    archive = fresh;
    await exporter().run(task, 'done');
    const out = extract(join(dest, 'my-workspace', tarballs()[0]!));
    try {
      expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).partial).toBe(true);
      expect(JSON.parse(readFileSync(join(out, 'operator-inputs.json'), 'utf8'))).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('records a succeeded Fact and the Archive export history', async () => {
    await exporter().run(task, 'done');

    expect(facts).toHaveLength(1);
    expect(facts[0]!.taskId).toBe(task.id);
    expect(facts[0]!.payload).toMatchObject({ event: 'export', disposition: 'done', destination: 'directory', status: 'succeeded' });
    expect(facts[0]!.payload.file).toBe(join(dest, 'my-workspace', tarballs()[0]!));
    const archiveJson = JSON.parse(readFileSync(join(await archive.ensure(task), 'archive.json'), 'utf8'));
    expect(archiveJson.exports).toHaveLength(1);
    expect(archiveJson.exports[0]).toMatchObject({ destination: 'directory', disposition: 'done', status: 'succeeded' });
  });

  it('builds nothing when Export is disabled but the Archive still exists', async () => {
    settingsFor = () => resolveExportSettings(globalWith(dest, false), undefined);

    expect(await exporter().run(task, 'done')).toBeNull();

    expect(existsSync(join(dest, 'my-workspace'))).toBe(false);
    expect(staging()).toEqual([]);
    expect(facts).toEqual([]);
    expect(existsSync(join(await archive.ensure(task), 'archive.json'))).toBe(true);
  });

  it('builds nothing when no directory path is configured', async () => {
    settingsFor = () => resolveExportSettings(globalWith(null), undefined);
    expect(await exporter().run(task, 'done')).toBeNull();
    expect(staging()).toEqual([]);
  });

  it('honours the Workspace override path', async () => {
    const override = mkdtempSync(join(tmpdir(), 'harmonic-export-override-'));
    try {
      settingsFor = () => resolveExportSettings(globalWith(dest), { exportEnabled: null, exportDirectoryPath: override });
      await exporter().run(task, 'done');
      expect(readdirSync(join(override, 'my-workspace'))).toHaveLength(1);
      expect(existsSync(join(dest, 'my-workspace'))).toBe(false);
    } finally {
      rmSync(override, { recursive: true, force: true });
    }
  });

  it('resolves and records a failed Fact when the destination is a regular file', async () => {
    const blocked = join(dest, 'blocked');
    writeFileSync(blocked, 'not a directory');
    settingsFor = () => resolveExportSettings(globalWith(blocked), undefined);

    const outcome = await exporter().run(task, 'done');

    expect(outcome?.status).toBe('failed');
    expect(facts[0]!.payload).toMatchObject({ event: 'export', status: 'failed', destination: 'directory' });
    expect(typeof facts[0]!.payload.error).toBe('string');
    expect(staging()).toEqual([]);
    const archiveJson = JSON.parse(readFileSync(join(await archive.ensure(task), 'archive.json'), 'utf8'));
    expect(archiveJson.exports[0]).toMatchObject({ status: 'failed' });
  });

  it.skipIf(process.getuid?.() === 0)('records a failed Fact when the destination directory is read-only', async () => {
    const readOnly = join(dest, 'ro');
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    settingsFor = () => resolveExportSettings(globalWith(readOnly), undefined);

    const outcome = await exporter().run(task, 'done');

    expect(outcome?.status).toBe('failed');
    expect(facts[0]!.payload.status).toBe('failed');
    expect(staging()).toEqual([]);
    chmodSync(readOnly, 0o700);
  });

  it('never overwrites an earlier Export', async () => {
    await exporter().run(task, 'done');
    const first = tarballs()[0]!;
    const firstPath = join(dest, 'my-workspace', first);
    const before = readFileSync(firstPath);

    await exporter().run(task, 'done');

    const names = tarballs();
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(readFileSync(firstPath).equals(before)).toBe(true);
    const history = JSON.parse(readFileSync(join(await archive.ensure(task), 'archive.json'), 'utf8')).exports;
    expect(history).toHaveLength(2);
  });

  it('trigger never throws and still exports in the background', async () => {
    const failing = new TaskExporter({
      dataDir: dir,
      archive,
      version: '1',
      settings: async () => {
        throw new Error('settings boom');
      },
      workspaceName: async () => null,
      snapshot: async () => ({ ticket: {}, timeline: {}, attemptCount: 0 }),
      recordFact: async () => undefined,
    });
    expect(() => failing.trigger(task, 'done')).not.toThrow();

    exporter().trigger(task, 'done');
    for (let i = 0; i < 200 && tarballs().length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(tarballs()).toHaveLength(1);
  });

  it('exports nothing and records no Fact when the settings lookup rejects', async () => {
    const outcome = await exporter({
      settings: async () => {
        throw new Error('workspace lookup failed');
      },
    }).run(task, 'done');

    expect(outcome).toBeNull();
    expect(existsSync(join(dest, 'my-workspace'))).toBe(false);
    expect(facts).toEqual([]);
  });

  it('captures the snapshot synchronously at trigger time', async () => {
    let counter = 0;
    const seen: number[] = [];
    const sut = exporter({
      snapshot: async () => {
        seen.push(++counter);
        return { ticket: { value: counter }, timeline: {}, attemptCount: 1 };
      },
    });

    sut.trigger(task, 'done');
    expect(seen).toEqual([1]);
    sut.trigger(task, 'done');
    expect(seen).toEqual([1, 2]);

    for (let i = 0; i < 200 && tarballs().length < 2; i++) await new Promise((r) => setTimeout(r, 25));
    const values: number[] = [];
    for (const name of tarballs()) {
      const out = extract(join(dest, 'my-workspace', name));
      values.push(JSON.parse(readFileSync(join(out, 'ticket.json'), 'utf8')).value);
      rmSync(out, { recursive: true, force: true });
    }
    expect(values.sort()).toEqual([1, 2]);
  });

  it('suffixes -1 on a filename collision and leaves the first tarball untouched', async () => {
    const now = new Date('2026-01-02T03:04:05.006Z');
    const sut = exporter({ now: () => now });
    await sut.run(task, 'done');
    const base = `${task.id}-done-20260102T030405.006Z`;
    const first = join(dest, 'my-workspace', `${base}.tar.gz`);
    const before = readFileSync(first);

    await sut.run(task, 'done');

    expect(tarballs().sort()).toEqual([`${base}-1.tar.gz`, `${base}.tar.gz`]);
    expect(readFileSync(first).equals(before)).toBe(true);
  });

  it('includes the tracker reference in the filename', async () => {
    const now = new Date('2026-01-02T03:04:05.006Z');
    await exporter({ now: () => now }).run({ ...task, trackerRef: 42 }, 'done');
    expect(tarballs()).toEqual([`${task.id}-42-done-20260102T030405.006Z.tar.gz`]);
  });

  it('sweepStaging removes leftovers and tolerates a missing directory', async () => {
    const sut = exporter();
    await expect(sut.sweepStaging()).resolves.toBeUndefined();
    const stagingDir = join(dir, 'archive', '.staging');
    mkdirSync(join(stagingDir, 'stale-dir'), { recursive: true });
    writeFileSync(join(stagingDir, 'stale-dir', 'x'), 'x');
    writeFileSync(join(stagingDir, '1-abc.tar.gz'), 'partial');

    await sut.sweepStaging();

    expect(staging()).toEqual([]);
    expect(existsSync(stagingDir)).toBe(true);
  });
});
