import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, utimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { type AsyncDbHandle, openAsyncDb } from '../src/db/async.js';
import type { TaskRow } from '../src/db/schema.js';
import { TaskService } from '../src/domain/tasks.js';
import { resolveExportSettings } from '../src/archive/export-settings.js';
import { TaskArchive } from '../src/archive/task-archive.js';
import { EXPORT_RETRY_DELAYS_MS, TaskExporter, type ExportFailure, type TaskExporterDeps } from '../src/archive/task-export.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';
import { emptyGitProvenance } from '../src/archive/git-provenance.js';

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
      epicSettings: async () => settingsFor(),
      epicSnapshot: async () => ({ ticket: {}, timeline: {}, attemptCount: 0, members: [] }),
      workspaceName: async () => 'My Workspace',
      snapshot: async () => ({ ticket: { title: 'Ticket title', id: task.id }, timeline: { events: [{ kind: 'fact' }] }, attemptCount: 1, git: emptyGitProvenance() }),
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

    expect(outcome?.[0]?.status).toBe('succeeded');
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
        formatVersion: 2,
        harmonicVersion: '9.9.9',
        taskId: task.id,
        workspace: 'My Workspace',
        disposition: 'done',
        redaction: { applied: true, matches: { 'github-token': 0, bearer: 0 } },
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
      settingsFor = () => resolveExportSettings(globalWith(dest), { exportEnabled: null, exportDirectoryPath: override, exportRedactPatterns: null });
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

    expect(outcome?.[0]?.status).toBe('failed');
    expect(facts[0]!.payload).toMatchObject({ event: 'export', status: 'failed', destination: 'directory' });
    expect(typeof facts[0]!.payload.error).toBe('string');
    expect(staging().filter((n) => n.endsWith('.pending.json'))).toHaveLength(1);
    const archiveJson = JSON.parse(readFileSync(join(await archive.ensure(task), 'archive.json'), 'utf8'));
    expect(archiveJson.exports[0]).toMatchObject({ status: 'failed' });
  });

  it.skipIf(process.getuid?.() === 0)('records a failed Fact when the destination directory is read-only', async () => {
    const readOnly = join(dest, 'ro');
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    settingsFor = () => resolveExportSettings(globalWith(readOnly), undefined);

    const outcome = await exporter().run(task, 'done');

    expect(outcome?.[0]?.status).toBe('failed');
    expect(facts[0]!.payload.status).toBe('failed');
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
      epicSettings: async () => settingsFor(),
      epicSnapshot: async () => ({ ticket: {}, timeline: {}, attemptCount: 0, members: [] }),
      workspaceName: async () => null,
      snapshot: async () => ({ ticket: {}, timeline: {}, attemptCount: 0, git: emptyGitProvenance() }),
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
        return { ticket: { value: counter }, timeline: {}, attemptCount: 1, git: emptyGitProvenance() };
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

  describe('failure handling and retries (#738)', () => {
    const MIN = 60_000;
    const T0 = Date.parse('2026-01-01T00:00:00.000Z');
    let clock: number;
    let failures: ExportFailure[];
    let blocked: string;

    const sut = (): TaskExporter =>
      exporter({
        now: () => new Date(clock),
        onFailure: (f) => {
          failures.push(f);
        },
      });
    const sidecars = (): string[] => staging().filter((n) => n.endsWith('.pending.json'));
    const stagedTarballs = (): string[] => staging().filter((n) => n.endsWith('.tar.gz'));
    const heal = (): void => {
      rmSync(blocked, { force: true });
      mkdirSync(blocked);
    };
    const breakIt = (): void => {
      rmSync(blocked, { recursive: true, force: true });
      writeFileSync(blocked, 'not a directory');
    };

    beforeEach(() => {
      clock = T0;
      failures = [];
      blocked = join(dest, 'blocked');
      writeFileSync(blocked, 'not a directory');
      settingsFor = () => resolveExportSettings(globalWith(blocked), undefined);
    });

    it('fails without touching Task state and schedules the first retry at +5m', async () => {
      const outcome = await sut().run(task, 'done');

      expect(outcome?.[0]?.status).toBe('failed');
      expect(task.state).toBe('ready');
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ destination: 'directory', disposition: 'done', retry: 0, nextRetryAt: new Date(T0 + 5 * MIN).toISOString() });
      expect(failures[0]!.task.id).toBe(task.id);
      expect(stagedTarballs()).toHaveLength(1);
      expect(sidecars()).toHaveLength(1);
      expect(EXPORT_RETRY_DELAYS_MS).toEqual([5 * MIN, 30 * MIN, 120 * MIN]);
    });

    it('a throwing onFailure hook never breaks the export', async () => {
      const outcome = await exporter({
        onFailure: () => {
          throw new Error('boom');
        },
      }).run(task, 'done');
      expect(outcome?.[0]?.status).toBe('failed');
    });

    it('a build failure has nothing to retry and reports nextRetryAt null', async () => {
      const outcome = await sut().run(task, 'done', Promise.reject(new Error('snapshot broke')));
      expect(outcome?.[0]?.status).toBe('failed');
      expect(failures[0]).toMatchObject({ retry: 0, nextRetryAt: null, error: 'snapshot broke' });
      expect(staging()).toEqual([]);
    });

    it('does nothing before a retry is due', async () => {
      const e = sut();
      await e.run(task, 'done');
      clock = T0 + 5 * MIN - 1;
      await e.retryDue();
      expect(failures).toHaveLength(1);
      expect(facts).toHaveLength(1);
    });

    it('retries at +5m, +30m and +2h from the first failure, then stops', async () => {
      const e = sut();
      await e.run(task, 'done');
      const expected = [30 * MIN, 120 * MIN, null];
      for (const [i, delay] of EXPORT_RETRY_DELAYS_MS.entries()) {
        clock = T0 + delay;
        await e.retryDue();
        expect(failures).toHaveLength(i + 2);
        const f = failures[i + 1]!;
        expect(f.retry).toBe(i + 1);
        expect(f.nextRetryAt).toBe(expected[i] === null ? null : new Date(T0 + expected[i]!).toISOString());
      }
      expect(sidecars()).toEqual([]);
      expect(stagedTarballs()).toEqual([]);
      expect(facts).toHaveLength(4);
      expect(facts[3]!.payload).toMatchObject({ status: 'failed', retry: 3 });

      clock = T0 + 600 * MIN;
      await e.retryDue();
      expect(failures).toHaveLength(4);
      expect(facts).toHaveLength(4);
      const archiveJson = JSON.parse(readFileSync(join(await archive.ensure(task), 'archive.json'), 'utf8'));
      expect(archiveJson.exports).toHaveLength(4);
    });

    it('a successful retry records a succeeded Fact, cleans staging and raises no failure', async () => {
      const e = sut();
      await e.run(task, 'done');
      heal();
      clock = T0 + 5 * MIN;
      await e.retryDue();

      expect(failures).toHaveLength(1);
      expect(facts).toHaveLength(2);
      expect(facts[1]!.payload).toMatchObject({ status: 'succeeded', retry: 1 });
      expect(staging()).toEqual([]);
      const delivered = readdirSync(join(blocked, 'my-workspace'));
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatch(TARBALL);
      const archiveJson = JSON.parse(readFileSync(join(await archive.ensure(task), 'archive.json'), 'utf8'));
      expect(archiveJson.exports.map((x: { status: string }) => x.status)).toEqual(['failed', 'succeeded']);
    });

    it('retries after an intermediate failure can still succeed', async () => {
      const e = sut();
      await e.run(task, 'done');
      clock = T0 + 5 * MIN;
      await e.retryDue();
      heal();
      clock = T0 + 30 * MIN;
      await e.retryDue();
      expect(failures).toHaveLength(2);
      expect(staging()).toEqual([]);
      expect(readdirSync(join(blocked, 'my-workspace'))).toHaveLength(1);
      breakIt();
    });

    it('sweepStaging keeps pending pairs and removes orphans', async () => {
      await sut().run(task, 'done');
      const stagingDir = join(dir, 'archive', '.staging');
      const kept = [...staging()].sort();
      writeFileSync(join(stagingDir, '9-orphan.tar.gz'), 'x');
      writeFileSync(join(stagingDir, '9-lonely.pending.json'), '{}');
      writeFileSync(join(stagingDir, '9-x.pending.json.abc.tmp'), '{}');
      const old = new Date(Date.now() - 60_000);
      for (const n of ['9-orphan.tar.gz', '9-lonely.pending.json', '9-x.pending.json.abc.tmp']) utimesSync(join(stagingDir, n), old, old);

      await sut().sweepStaging();

      expect([...staging()].sort()).toEqual(kept);
      expect(kept).toHaveLength(2);
    });

    it('sweepStaging skips entries created by this process', async () => {
      const e = sut();
      await new Promise((r) => setTimeout(r, 20));
      const stagingDir = join(dir, 'archive', '.staging');
      mkdirSync(stagingDir, { recursive: true });
      writeFileSync(join(stagingDir, '5-fresh.tar.gz'), 'in flight');
      await e.sweepStaging();
      expect(staging()).toEqual(['5-fresh.tar.gz']);
    });

    it('discards a malformed sidecar and its tarball', async () => {
      const e = sut();
      await e.run(task, 'done');
      const stagingDir = join(dir, 'archive', '.staging');
      const [sidecar] = sidecars();
      const value = JSON.parse(readFileSync(join(stagingDir, sidecar!), 'utf8'));
      value.destinations[0].nextRetryAt = 'not a date';
      writeFileSync(join(stagingDir, sidecar!), JSON.stringify(value));
      clock = T0 + 5 * MIN;
      await e.retryDue();
      expect(staging()).toEqual([]);
      expect(failures).toHaveLength(1);
    });

    it('a fresh exporter after restart sweeps, then retries and delivers', async () => {
      await sut().run(task, 'done');
      const before = [...staging()].sort();
      await new Promise((r) => setTimeout(r, 20));
      const restarted = sut();
      await restarted.sweepStaging();
      expect([...staging()].sort()).toEqual(before);
      heal();
      clock = T0 + 5 * MIN;
      await restarted.retryDue();
      expect(staging()).toEqual([]);
      expect(readdirSync(join(blocked, 'my-workspace'))).toHaveLength(1);
      expect(facts.at(-1)!.payload).toMatchObject({ status: 'succeeded', retry: 1 });
    });

    it('a corrupt sidecar does not break the retry loop', async () => {
      const e = sut();
      await e.run(task, 'done');
      writeFileSync(join(dir, 'archive', '.staging', '0-corrupt.pending.json'), '{not json');
      heal();
      clock = T0 + 5 * MIN;
      await expect(e.retryDue()).resolves.toBeUndefined();
      expect(facts.at(-1)!.payload.status).toBe('succeeded');
    });

    it('bounds one retry pass to 20 deliveries', async () => {
      const e = sut();
      await e.run(task, 'done');
      const stagingDir = join(dir, 'archive', '.staging');
      const [sidecar] = sidecars();
      const [tarball] = stagedTarballs();
      const template = JSON.parse(readFileSync(join(stagingDir, sidecar!), 'utf8'));
      for (let i = 0; i < 24; i++) {
        writeFileSync(join(stagingDir, `${task.id}-copy${i}.tar.gz`), readFileSync(join(stagingDir, tarball!)));
        const entry = { ...template, destinations: [{ ...template.destinations[0], dir: join(dest, 'ok'), base: `copy${i}` }] };
        writeFileSync(join(stagingDir, `${task.id}-copy${i}.pending.json`), JSON.stringify(entry));
      }
      heal();
      clock = T0 + 5 * MIN;
      await e.retryDue();

      expect(sidecars()).toHaveLength(5);
      const count = (d: string): number => (existsSync(d) ? readdirSync(d).length : 0);
      expect(count(join(dest, 'ok')) + count(join(blocked, 'my-workspace'))).toBe(20);
      await e.retryDue();
      expect(sidecars()).toEqual([]);
    });
  });

  it('sweepStaging removes leftovers and tolerates a missing directory', async () => {
    const sut = exporter();
    await expect(sut.sweepStaging()).resolves.toBeUndefined();
    const stagingDir = join(dir, 'archive', '.staging');
    mkdirSync(join(stagingDir, 'stale-dir'), { recursive: true });
    writeFileSync(join(stagingDir, 'stale-dir', 'x'), 'x');
    writeFileSync(join(stagingDir, '1-abc.tar.gz'), 'partial');
    const old = new Date(Date.now() - 60_000);
    for (const p of [join(stagingDir, 'stale-dir'), join(stagingDir, '1-abc.tar.gz')]) utimesSync(p, old, old);

    await sut.sweepStaging();

    expect(staging()).toEqual([]);
    expect(existsSync(stagingDir)).toBe(true);
  });
  describe('terminal dispositions (#735)', () => {
    const withStates = (includeStates: Array<'done' | 'cancelled' | 'deleted'>) => () => {
      const config = globalWith(dest);
      return resolveExportSettings({ ...config, export: { ...config.export, includeStates } }, undefined);
    };

    it('produces a -cancelled- Export for a cancelled Task', async () => {
      await exporter().run(task, 'cancelled');
      expect(tarballs()).toHaveLength(1);
      expect(tarballs()[0]).toMatch(/^\d+-cancelled-\d{8}T\d{6}\.\d{3}Z\.tar\.gz$/);
      expect(facts[0]!.payload).toMatchObject({ disposition: 'cancelled', status: 'succeeded' });
    });

    it('captureForDelete exports the pre-delete snapshot as -deleted- and records history without a Fact', async () => {
      let rowsGone = false;
      const sut = exporter({
        snapshot: async () => {
          const value = rowsGone ? 'after' : 'before';
          await new Promise((r) => setTimeout(r, 20));
          return { ticket: { title: value }, timeline: { events: [value] }, attemptCount: 2, git: emptyGitProvenance() };
        },
      });
      await sut.captureForDelete(task);
      rowsGone = true;

      for (let i = 0; i < 200 && tarballs().length === 0; i++) await new Promise((r) => setTimeout(r, 25));
      expect(tarballs()[0]).toMatch(/-deleted-/);
      const out = extract(join(dest, 'my-workspace', tarballs()[0]!));
      expect(JSON.parse(readFileSync(join(out, 'ticket.json'), 'utf8'))).toEqual({ title: 'before' });
      expect(JSON.parse(readFileSync(join(out, 'timeline.json'), 'utf8'))).toEqual({ events: ['before'] });
      rmSync(out, { recursive: true, force: true });
      for (let i = 0; i < 200; i++) {
        const history = JSON.parse(readFileSync(join(await archive.ensure(task), 'archive.json'), 'utf8')).exports;
        if (history?.length) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const history = JSON.parse(readFileSync(join(await archive.ensure(task), 'archive.json'), 'utf8')).exports;
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ disposition: 'deleted', status: 'succeeded' });
      expect(facts).toEqual([]);
    });

    it('produces no Export when deleting a Task that never ran', async () => {
      await exporter({ snapshot: async () => ({ ticket: {}, timeline: {}, attemptCount: 0, git: emptyGitProvenance() }) }).captureForDelete(task);
      await new Promise((r) => setTimeout(r, 100));
      expect(tarballs()).toEqual([]);
    });

    it('does not snapshot on delete when Export is disabled', async () => {
      let snapshots = 0;
      settingsFor = () => resolveExportSettings(globalWith(dest, false), undefined);
      await exporter({
        snapshot: async () => {
          snapshots++;
          return { ticket: {}, timeline: {}, attemptCount: 1, git: emptyGitProvenance() };
        },
      }).captureForDelete(task);
      expect(snapshots).toBe(0);
    });

    it('captureForDelete never throws when the snapshot or settings fail', async () => {
      await expect(
        exporter({
          snapshot: async () => {
            throw new Error('snapshot boom');
          },
        }).captureForDelete(task),
      ).resolves.toBeUndefined();
      await expect(
        exporter({
          settings: async () => {
            throw new Error('settings boom');
          },
        }).captureForDelete(task),
      ).resolves.toBeUndefined();
      expect(tarballs()).toEqual([]);
    });

    it('a second disposition yields a second tarball and leaves the first untouched', async () => {
      await exporter().run(task, 'cancelled');
      const first = tarballs()[0]!;
      const before = readFileSync(join(dest, 'my-workspace', first));
      await exporter().run(task, 'done');
      expect(tarballs()).toHaveLength(2);
      expect(readFileSync(join(dest, 'my-workspace', first)).equals(before)).toBe(true);
    });

    it('includeStates excluding a disposition suppresses its Export', async () => {
      settingsFor = withStates(['done']);
      expect(await exporter().run(task, 'cancelled')).toBeNull();
      await exporter().captureForDelete(task);
      await new Promise((r) => setTimeout(r, 100));
      expect(tarballs()).toEqual([]);
      settingsFor = withStates(['cancelled']);
      await exporter().run(task, 'cancelled');
      expect(tarballs()).toHaveLength(1);
    });
  });

  describe('redaction (#736)', () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`;
    let outputLog: string;

    beforeEach(async () => {
      const log = await archive.verificationOutputLog(task, 1, 'pre-merge', 'test');
      outputLog = log!;
    });

    const exportedFile = (rel: string): { text: string; manifest: { redaction: { applied: boolean; matches: Record<string, number> } } } => {
      const out = extract(join(dest, 'my-workspace', tarballs()[0]!));
      try {
        return { text: readFileSync(join(out, rel), 'utf8'), manifest: JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) };
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    };

    it('redacts a GitHub token in verify output and leaves the local Archive raw', async () => {
      writeFileSync(outputLog, `$ npm test\nusing ${token}\nok\n`);
      expect((await exporter().run(task, 'done'))?.[0]?.status).toBe('succeeded');
      const { text, manifest } = exportedFile('attempts/1/verification/pre-merge/test/output.log');
      expect(text).toBe('$ npm test\nusing [REDACTED:github-token]\nok\n');
      expect(readFileSync(outputLog, 'utf8')).toContain(token);
      expect(manifest.redaction.applied).toBe(true);
      expect(manifest.redaction.matches).toMatchObject({ 'github-token': 1, 'aws-access-key': 0, 'aws-secret-key': 0, 'gitlab-token': 0, bearer: 0, 'sk-api-key': 0 });
    });

    it('applies a Workspace pattern alongside the baseline and global patterns', async () => {
      writeFileSync(outputLog, `curl https://corp.example.internal/${token} secret-marker\n`);
      const global = globalWith(dest);
      global.export.redact.patterns = [{ id: 'global-marker', regex: 'secret-marker' }];
      settingsFor = () =>
        resolveExportSettings(global, {
          exportEnabled: null,
          exportDirectoryPath: null,
          exportRedactPatterns: JSON.stringify([{ id: 'internal-host', regex: 'corp\\.example\\.internal' }]),
        });
      await exporter().run(task, 'done');
      const { text, manifest } = exportedFile('attempts/1/verification/pre-merge/test/output.log');
      expect(text).toBe('curl https://[REDACTED:internal-host]/[REDACTED:github-token] [REDACTED:global-marker]\n');
      expect(manifest.redaction.matches).toMatchObject({ 'internal-host': 1, 'github-token': 1, 'global-marker': 1 });
    });

    it('redacts a token that straddles a read-stream chunk boundary', async () => {
      const padding = 'x'.repeat(64 * 1024 - 10);
      writeFileSync(outputLog, `${padding} ${token} ${'y'.repeat(100 * 1024)}\n`);
      await exporter().run(task, 'done');
      const { text, manifest } = exportedFile('attempts/1/verification/pre-merge/test/output.log');
      expect(text).toBe(`${padding} [REDACTED:github-token] ${'y'.repeat(100 * 1024)}\n`);
      expect(manifest.redaction.matches['github-token']).toBe(1);
    });

    it('redacts the ticket and timeline documents too', async () => {
      await exporter({
        snapshot: async () => ({ ticket: { title: `leak ${token}` }, timeline: { note: 'Bearer abcdefgh1jklmnopqr' }, attemptCount: 1, git: emptyGitProvenance() }),
      }).run(task, 'done');
      expect(exportedFile('ticket.json').text).toContain('leak [REDACTED:github-token]');
      const { text, manifest } = exportedFile('timeline.json');
      expect(text).toContain('Bearer [REDACTED:bearer]');
      expect(exportedFile('README.md').text).toContain('# leak [REDACTED:github-token]');
      expect(manifest.redaction.matches).toMatchObject({ 'github-token': 2, bearer: 1 });
    });
  });
});
