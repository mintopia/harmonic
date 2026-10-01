import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineConfig } from '../src/config.js';
import { type AsyncDbHandle, openAsyncDb } from '../src/db/async.js';
import { eq } from 'drizzle-orm';
import { tasks as tasksTable, type TaskRow } from '../src/db/schema.js';
import { TaskService } from '../src/domain/tasks.js';
import { resolveExportSettings } from '../src/archive/export-settings.js';
import { TaskArchive } from '../src/archive/task-archive.js';
import type { EpicExportStep } from '../src/domain/epic-merge-events.js';
import { TaskExporter, type EpicExportSnapshot, type ExportFailure, type TaskExporterDeps } from '../src/archive/task-export.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';
import { emptyGitProvenance } from '../src/archive/git-provenance.js';

const EPIC = 77;

function config(path: string | null, enabled = true) {
  const base = baselineConfig();
  return { ...base, export: { ...base.export, enabled, directory: { ...base.export.directory, path } } };
}

function extract(tarball: string): string {
  const out = mkdtempSync(join(tmpdir(), 'harmonic-epic-extract-'));
  execFileSync('tar', ['-xzf', tarball, '-C', out]);
  return out;
}

function listAll(root: string, rel = ''): string[] {
  return readdirSync(join(root, rel), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listAll(root, join(rel, e.name)) : [join(rel, e.name)]))
    .sort();
}

describe('Epic Export (#739)', () => {
  let dir: string;
  let dest: string;
  let asyncDb: AsyncDbHandle;
  let archive: TaskArchive;
  let members: TaskRow[];
  let enabled: boolean;
  let workspaceId: number;

  const snapshot = (): EpicExportSnapshot => ({
    ticket: { title: 'Epic title', ref: EPIC },
    timeline: { events: [{ kind: 'integrated' }], attempts: [{ number: 1 }] },
    attemptCount: 1,
    members: [...members.map((task) => ({ ref: task.trackerRef!, task })), { ref: 999, task: null }],
  });

  const exporter = (overrides: Partial<TaskExporterDeps> = {}): TaskExporter =>
    new TaskExporter({
      dataDir: dir,
      archive,
      version: '9.9.9',
      settings: async () => resolveExportSettings(config(dest, enabled), undefined),
      epicSettings: async () => resolveExportSettings(config(dest, enabled), undefined),
      epicSnapshot: async () => snapshot(),
      workspaceName: async () => 'My Workspace',
      snapshot: async () => ({ ticket: {}, timeline: {}, attemptCount: 0, git: emptyGitProvenance() }),
      recordEpicStep: async () => undefined,
      recordFact: async () => undefined,
      ...overrides,
    });

  const tarballs = (): string[] => {
    const slugDir = join(dest, 'my-workspace');
    return existsSync(slugDir) ? readdirSync(slugDir).filter((n) => !n.startsWith('.')) : [];
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-epic-export-data-'));
    dest = mkdtempSync(join(tmpdir(), 'harmonic-epic-export-dest-'));
    enabled = true;
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    const tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, await makeSettingsStore(dir)));
    const first = await tasks.create({ prompt: 'member one', state: 'ready', workingDir: dir, isolationMode: 'direct' });
    const second = await tasks.create({ prompt: 'member two', state: 'ready', workingDir: dir, isolationMode: 'direct' });
    workspaceId = first.workspaceId!;
    const tracked = async (task: TaskRow, ref: number, state: 'done' | 'working'): Promise<TaskRow> => {
      await asyncDb.write((db) => db.update(tasksTable).set({ trackerRef: ref, state }).where(eq(tasksTable.id, task.id)).run());
      return tasks.get(task.id);
    };
    members = [await tracked(first, 11, 'done'), await tracked(second, 12, 'working')];
    archive = new TaskArchive({ dataDir: dir, ensureArchiveId: (id) => tasks.ensureArchiveId(id), workspaceName: async () => 'My Workspace' });
    members = await Promise.all(members.map((m) => tasks.get(m.id)));

    const memberDir = await archive.ensure(members[0]!);
    mkdirSync(join(memberDir, 'attempts', '1', 'implementation'), { recursive: true });
    writeFileSync(join(memberDir, 'attempts', '1', 'implementation', 'prompt.md'), 'MEMBER SECRET');

    const epicDir = await archive.ensureEpic(workspaceId, EPIC);
    const critic = join(epicDir, 'attempts', '1', 'verification', 'pre-merge', '5');
    mkdirSync(critic, { recursive: true });
    writeFileSync(join(critic, 'prompt.md'), 'critic prompt');
    const log = await archive.epicVerificationOutputLog(workspaceId, EPIC, 1, 'cmd-test');
    writeFileSync(log!, 'command output');
  });

  afterEach(async () => {
    await asyncDb.close();
    for (const d of [dir, dest]) rmSync(d, { recursive: true, force: true });
  });

  it('puts Epic Attempt verification and Critic outputs, timeline and referenced Members in the tarball', async () => {
    await archive.recordExport(members[0]!, { destination: 'directory', disposition: 'done', file: '/x/y/11-done-A.tar.gz', status: 'succeeded', at: 't' });
    const outcome = await exporter().runEpic(workspaceId, EPIC, 'done');

    expect(outcome?.map((o) => o.status)).toEqual(['succeeded']);
    const names = tarballs();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`^epic-${EPIC}-done-\\d{8}T\\d{6}\\.\\d{3}Z\\.tar\\.gz$`));

    const out = extract(join(dest, 'my-workspace', names[0]!));
    try {
      expect(listAll(out)).toEqual([
        'README.md',
        'archive.json',
        'attempts/1/verification/pre-merge/5/prompt.md',
        'attempts/1/verification/pre-merge/cmd-test/output.log',
        'manifest.json',
        'operator-inputs.json',
        'ticket.json',
        'timeline.json',
      ]);
      expect(readFileSync(join(out, 'attempts/1/verification/pre-merge/cmd-test/output.log'), 'utf8')).toBe('command output');
      expect(JSON.parse(readFileSync(join(out, 'timeline.json'), 'utf8'))).toEqual({ events: [{ kind: 'integrated' }], attempts: [{ number: 1 }] });
      const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({ format: 'harmonic-epic-export', epicRef: EPIC, disposition: 'done', workspace: 'My Workspace', partial: false });
      expect(manifest.members).toEqual([
        { ref: 11, taskId: members[0]!.id, status: 'done', export: '11-done-A.tar.gz' },
        { ref: 12, taskId: members[1]!.id, status: 'working', export: null },
        { ref: 999, taskId: null, status: null, export: null },
      ]);
      expect(readFileSync(join(out, 'README.md'), 'utf8')).toContain('| #11 | done | `11-done-A.tar.gz` |');
      for (const file of listAll(out)) {
        expect(file).not.toContain('implementation');
        expect(readFileSync(join(out, file), 'utf8')).not.toContain('MEMBER SECRET');
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }

    const history = JSON.parse(readFileSync(join(dir, 'archive', 'my-workspace', `epic-${EPIC}`, 'archive.json'), 'utf8')).exports;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: 'succeeded', disposition: 'done' });
  });

  it('skips a repeated done Export for an Epic that already has a succeeded one', async () => {
    const ex = exporter();
    expect((await ex.runEpic(workspaceId, EPIC, 'done'))?.[0]?.status).toBe('succeeded');
    expect(await ex.runEpic(workspaceId, EPIC, 'done')).toBeNull();
    ex.triggerEpic(workspaceId, EPIC, 'done');
    await new Promise((r) => setTimeout(r, 100));
    expect(tarballs()).toHaveLength(1);
  });

  it('captures the snapshot synchronously at trigger time', async () => {
    let title = 'before';
    const ex = exporter({ epicSnapshot: async () => ({ ...snapshot(), ticket: { title } }) });
    ex.triggerEpic(workspaceId, EPIC, 'done');
    title = 'after';
    for (let i = 0; i < 200 && tarballs().length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    const out = extract(join(dest, 'my-workspace', tarballs()[0]!));
    try {
      expect(JSON.parse(readFileSync(join(out, 'ticket.json'), 'utf8'))).toEqual({ title: 'before' });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('builds nothing when Export is disabled', async () => {
    enabled = false;
    expect(await exporter().runEpic(workspaceId, EPIC, 'done')).toBeNull();
    expect(tarballs()).toEqual([]);
  });

  it('records a failed Export and does not throw when the snapshot fails', async () => {
    const failing = exporter({ epicSnapshot: async () => { throw new Error('snapshot boom'); } });
    const outcome = await failing.runEpic(workspaceId, EPIC, 'done');
    expect(outcome).toMatchObject([{ status: 'failed', error: 'snapshot boom' }]);
    const history = JSON.parse(readFileSync(join(dir, 'archive', 'my-workspace', `epic-${EPIC}`, 'archive.json'), 'utf8')).exports;
    expect(history.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('waits for an in-flight Member Export so the Epic references it', async () => {
    const member = members[0]!;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ex = exporter({
      snapshot: async () => {
        await gate;
        return { ticket: {}, timeline: {}, attemptCount: 0, git: emptyGitProvenance() };
      },
    });
    ex.trigger(member, 'done');
    ex.triggerEpic(workspaceId, EPIC, 'done');
    await new Promise((r) => setTimeout(r, 50));
    expect(tarballs()).toEqual([]);
    release();
    for (let i = 0; i < 200 && tarballs().length < 2; i++) await new Promise((r) => setTimeout(r, 25));

    const names = tarballs();
    const epicTar = names.find((n) => n.startsWith('epic-'))!;
    const memberTar = names.find((n) => n.startsWith(`${member.id}-`))!;
    expect(memberTar).toBeDefined();
    const out = extract(join(dest, 'my-workspace', epicTar));
    try {
      const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
      expect(manifest.members[0].export).toBe(memberTar);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('exportHistory reads without creating an Archive', async () => {
    const tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, await makeSettingsStore(dir)));
    const fresh = await tasks.create({ prompt: 'no archive', state: 'ready', workingDir: dir, isolationMode: 'direct' });
    expect(await archive.exportHistory(fresh)).toEqual([]);
    expect(readdirSync(join(dir, 'archive', 'my-workspace')).some((n) => n.startsWith(`${fresh.id}-`))).toBe(false);
  });

  describe('failure handling and retries', () => {
    const MIN = 60_000;
    let clock: number;
    let failures: ExportFailure[];
    let blocked: string;
    const staging = (): string[] => readdirSync(join(dir, 'archive', '.staging'));
    const history = (): Array<Record<string, unknown>> => JSON.parse(readFileSync(join(dir, 'archive', 'my-workspace', `epic-${EPIC}`, 'archive.json'), 'utf8')).exports;

    beforeEach(() => {
      clock = Date.parse('2026-01-01T00:00:00.000Z');
      failures = [];
      steps = [];
      blocked = join(dest, 'my-workspace');
      writeFileSync(blocked, 'not a directory');
    });

    let steps: EpicExportStep[];
    const sut = (): TaskExporter => exporter({ now: () => new Date(clock), onFailure: (f) => void failures.push(f), recordEpicStep: async (_w, _e, step) => void steps.push(step) });

    it('records the failure, reports it for the Epic and retries to success once the Destination heals', async () => {
      const ex = sut();
      const outcomes = await ex.runEpic(workspaceId, EPIC, 'done');
      expect(outcomes?.map((o) => o.status)).toEqual(['failed']);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ owner: { kind: 'epic', workspaceId, epicRef: EPIC }, destination: 'directory', retry: 0, nextRetryAt: new Date(clock + 5 * MIN).toISOString() });
      expect(staging().filter((n) => n.endsWith('.pending.json'))).toHaveLength(1);
      expect([...(await ex.pendingOwnerKeys())]).toEqual([`epic:${workspaceId}:${EPIC}`]);
      expect((await ex.epicStatus(workspaceId, EPIC)).latest?.destinations[0]).toMatchObject({ status: 'failed', retry: { count: 0, nextRetryAt: new Date(clock + 5 * MIN).toISOString(), exhausted: false } });

      rmSync(blocked, { force: true });
      mkdirSync(blocked);
      clock += 6 * MIN;
      await ex.retryDue();

      expect(tarballs()).toHaveLength(1);
      expect(staging().filter((n) => n.endsWith('.pending.json') || n.endsWith('.tar.gz'))).toEqual([]);
      expect(history().map((h) => [h.status, h.retry])).toEqual([['failed', undefined], ['succeeded', 1]]);
      expect((await ex.pendingOwnerKeys()).size).toBe(0);
      expect(steps).toEqual([
        { step: 'export-built', disposition: 'done', name: expect.stringMatching(/^epic-77-done-/), bytes: expect.any(Number), partial: false },
        { step: 'export-failed', destination: 'directory', error: expect.stringContaining('EEXIST'), retry: 0, nextRetryAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + 5 * MIN).toISOString() },
        { step: 'export-delivered', destination: 'directory', file: expect.stringContaining('epic-77-done-'), retry: 1 },
      ]);
    });

    it('exports again regardless of an earlier succeeded Export and downloads without recording', async () => {
      rmSync(blocked, { force: true });
      const ex = sut();
      expect((await ex.runEpic(workspaceId, EPIC, 'done'))?.[0]?.status).toBe('succeeded');
      clock += MIN;
      expect((await ex.exportEpicAgain(workspaceId, EPIC))?.[0]?.status).toBe('succeeded');
      expect(tarballs()).toHaveLength(2);
      const download = await ex.buildEpicDownload(workspaceId, EPIC);
      expect(download.name).toMatch(new RegExp(`^epic-${EPIC}-done-`));
      expect(existsSync(download.path)).toBe(true);
      rmSync(download.path, { force: true });
      expect(history()).toHaveLength(2);
      expect((await ex.epicStatus(workspaceId, EPIC)).earlier).toHaveLength(1);
    });
  });
});
