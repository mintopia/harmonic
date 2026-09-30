import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { eq } from 'drizzle-orm';
import { tasks as tasksTable, workspaces } from '../src/db/schema.js';
import { TaskService } from '../src/domain/tasks.js';
import { TaskArchive } from '../src/archive/task-archive.js';
import { baselineConfig } from '../src/config.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';
import type { SettingsStore } from '../src/server/settings-store.js';

async function openDb(dir: string): Promise<{ db: AsyncDbHandle; tasks: TaskService; settings: SettingsStore }> {
  const db = await openAsyncDb(dir);
  await seedWorkspace(db);
  const settings = await makeSettingsStore(dir);
  return { db, tasks: new TaskService(db, () => baselineConfig(), allWorkspaces(db, settings)), settings };
}

describe('TaskArchive', () => {
  let dir: string;
  let db: AsyncDbHandle;
  let tasks: TaskService;

  const archiveFor = () =>
    new TaskArchive({
      dataDir: dir,
      ensureArchiveId: (id) => tasks.ensureArchiveId(id),
      workspaceName: async (id) => (await db.read((d) => d.select().from(workspaces).all())).find((w) => w.id === id)?.name ?? null,
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-archive-'));
    ({ db, tasks } = await openDb(dir));
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('assigns distinct UUID archive ids and fills a null one lazily', async () => {
    const a = await tasks.create({ prompt: 'one' });
    const b = await tasks.create({ prompt: 'two' });
    expect(a.archiveId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.archiveId).not.toBe(b.archiveId);
    await db.write((d) => d.update(tasksTable).set({ archiveId: null }).where(eq(tasksTable.id, a.id)).run());
    const filled = await tasks.ensureArchiveId(a.id);
    expect(filled).toMatch(/^[0-9a-f-]{36}$/);
    expect(await tasks.ensureArchiveId(a.id)).toBe(filled);
  });

  it('creates the directory layout and an archive.json, idempotently', async () => {
    const task = await tasks.create({ prompt: 'Fix the thing\nmore detail' });
    const archive = archiveFor();
    const [d1, d2] = await Promise.all([archive.ensure(task), archive.ensure(task)]);
    expect(d1).toBe(d2);
    expect(d1).toBe(join(dir, 'archive', 'default', `${task.id}-${task.archiveId}`));
    const manifest = JSON.parse(readFileSync(join(d1, 'archive.json'), 'utf8'));
    expect(manifest).toMatchObject({
      taskId: task.id,
      archiveId: task.archiveId,
      trackerRef: null,
      title: 'Fix the thing',
      workspace: 'Default',
      workspaceId: task.workspaceId,
      createdAt: new Date(task.createdAt).toISOString(),
      dispositions: [],
      exports: [],
    });
    writeFileSync(join(d1, 'archive.json'), '{"custom":true}');
    await archive.ensure(task);
    expect(readFileSync(join(d1, 'archive.json'), 'utf8')).toBe('{"custom":true}');
    expect(readdirSync(d1).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps archives separate when a recreated DB reuses a task id', async () => {
    const first = await tasks.create({ prompt: 'old' });
    const oldDir = await archiveFor().ensure(first);
    await db.close();

    const dbDir = mkdtempSync(join(tmpdir(), 'harmonic-archive-db-'));
    try {
      ({ db, tasks } = await openDb(dbDir));
      const second = await tasks.create({ prompt: 'new' });
      expect(second.id).toBe(first.id);
      const newDir = await archiveFor().ensure(second);
      expect(newDir).not.toBe(oldDir);
      expect(JSON.parse(readFileSync(join(oldDir, 'archive.json'), 'utf8')).title).toBe('old');
      expect(JSON.parse(readFileSync(join(newDir, 'archive.json'), 'utf8')).title).toBe('new');
    } finally {
      await db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it('writes prompt.md and acp.jsonl in order', async () => {
    const task = await tasks.create({ prompt: 'p' });
    const writer = archiveFor().implementationStep(task, 2);
    writer.appendPrompt('first');
    writer.appendUpdate({ n: 1 });
    writer.appendPrompt('second');
    writer.appendUpdate({ n: 2 });
    await writer.close();
    await writer.close();
    const stepDir = await writer.dir;
    expect(stepDir.endsWith(join('attempts', '2', 'implementation'))).toBe(true);
    expect(readFileSync(join(stepDir, 'prompt.md'), 'utf8')).toBe('first\n\n---\n\nsecond');
    const lines = readFileSync(join(stepDir, 'acp.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.update.n)).toEqual([1, 2]);
    expect(typeof lines[0].ts).toBe('number');
  });

  it('appends a later turn of the same Attempt to the existing prompt.md and acp.jsonl', async () => {
    const task = await tasks.create({ prompt: 'p' });
    const archive = archiveFor();
    const first = archive.implementationStep(task, 1);
    first.appendPrompt('first');
    first.appendUpdate({ n: 1 });
    await first.close();
    const second = archive.implementationStep(task, 1);
    second.appendPrompt('second');
    second.appendUpdate({ n: 2 });
    await second.close();
    const stepDir = await second.dir;
    expect(readFileSync(join(stepDir, 'prompt.md'), 'utf8')).toBe('first\n\n---\n\nsecond');
    const lines = readFileSync(join(stepDir, 'acp.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.update.n)).toEqual([1, 2]);
  });

  it('copies the native transcript and subagent files', async () => {
    const task = await tasks.create({ prompt: 'p' });
    const src = join(dir, 'src-projects');
    mkdirSync(join(src, 'sess-1', 'subagents'), { recursive: true });
    writeFileSync(join(src, 'sess-1.jsonl'), 'root\n');
    writeFileSync(join(src, 'sess-1', 'subagents', 'agent-a.jsonl'), 'sub\n');
    writeFileSync(join(src, 'sess-1', 'subagents', 'agent-a.meta.json'), '{}');

    const archive = archiveFor();
    const writer = archive.implementationStep(task, 1);
    await writer.copyNative('claude', join(src, 'sess-1.jsonl'));
    await writer.close();
    const native = join(await writer.dir, 'native');
    expect(readFileSync(join(native, 'sess-1.jsonl'), 'utf8')).toBe('root\n');
    expect(readFileSync(join(native, 'subagents', 'agent-a.jsonl'), 'utf8')).toBe('sub\n');
    expect(existsSync(join(native, 'subagents', 'agent-a.meta.json'))).toBe(true);

    writeFileSync(join(src, 'sess-1.jsonl'), 'root grown\n');
    await archive.copyNative(task, 1, 'claude', join(src, 'sess-1.jsonl'));
    expect(readFileSync(join(native, 'sess-1.jsonl'), 'utf8')).toBe('root grown\n');
  });

  it('does nothing for a null or missing transcript', async () => {
    const task = await tasks.create({ prompt: 'p' });
    const archive = archiveFor();
    await archive.copyNative(task, 1, 'claude', null);
    await archive.copyNative(task, 1, 'claude', join(dir, 'nope.jsonl'));
    const writer = archive.implementationStep(task, 3);
    await writer.copyNative('claude', null);
    await writer.copyNative('claude', join(dir, 'nope.jsonl'));
    await writer.close();
    expect(existsSync(join(await writer.dir, 'native'))).toBe(false);
  });

  it('creates a verification output.log directory per stage and step', async () => {
    const task = await tasks.create({ prompt: 'p' });
    const archive = archiveFor();
    const path = await archive.verificationOutputLog(task, 2, 'post-merge', 'cmd-lint');
    const root = await archive.ensure(task);
    expect(path).toBe(join(root, 'attempts', '2', 'verification', 'post-merge', 'cmd-lint', 'output.log'));
    expect(existsSync(join(root, 'attempts', '2', 'verification', 'post-merge', 'cmd-lint'))).toBe(true);
  });

  it('keeps hostile step ids inside the archive', async () => {
    const task = await tasks.create({ prompt: 'p' });
    const archive = archiveFor();
    const root = await archive.ensure(task);
    const stageDir = join(root, 'attempts', '1', 'verification', 'pre-merge');
    const ids = ['../../x', '', '.', '..', 'a/b', 'a-b'];
    const paths = await Promise.all(ids.map((id) => archive.verificationOutputLog(task, 1, 'pre-merge', id)));
    for (const path of paths) {
      expect(path).not.toBeNull();
      expect(dirname(dirname(path!))).toBe(stageDir);
      expect(existsSync(dirname(path!))).toBe(true);
    }
    expect(new Set(paths).size).toBe(ids.length);
  });

  it('resolves null when the archive cannot be ensured', async () => {
    const task = await tasks.create({ prompt: 'p' });
    const failing = new TaskArchive({
      dataDir: dir,
      ensureArchiveId: async () => {
        throw new Error('no id');
      },
      workspaceName: async () => null,
    });
    const bare = { ...task, archiveId: null };
    expect(await failing.verificationOutputLog(bare, 1, 'pre-merge', 'c')).toBeNull();
  });

  it('lays out a critic step and keeps concurrent critic writers separate', async () => {
    const task = await tasks.create({ prompt: 'p' });
    const archive = archiveFor();
    const a = archive.criticStep(task, 2, 'pre-merge', 'critic-a');
    const b = archive.criticStep(task, 2, 'post-merge', 'critic-b');
    const a2 = archive.criticStep(task, 2, 'pre-merge', 'critic-c');
    a.appendPrompt('prompt a');
    b.appendPrompt('prompt b');
    for (let n = 0; n < 5; n++) {
      a.appendUpdate({ from: 'a', n });
      b.appendUpdate({ from: 'b', n });
      a2.appendUpdate({ from: 'c', n });
    }
    await Promise.all([a.close(), b.close(), a2.close()]);
    const root = await archive.ensure(task);
    const aDir = join(root, 'attempts', '2', 'verification', 'pre-merge', 'critic-a');
    const bDir = join(root, 'attempts', '2', 'verification', 'post-merge', 'critic-b');
    expect(await a.dir).toBe(aDir);
    expect(await b.dir).toBe(bDir);
    expect(readFileSync(join(aDir, 'prompt.md'), 'utf8')).toBe('prompt a');
    expect(readFileSync(join(bDir, 'prompt.md'), 'utf8')).toBe('prompt b');
    const froms = (d: string) =>
      readFileSync(join(d, 'acp.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).update.from);
    expect(froms(aDir)).toEqual(['a', 'a', 'a', 'a', 'a']);
    expect(froms(bDir)).toEqual(['b', 'b', 'b', 'b', 'b']);
  });

  it('creates an epic archive idempotently and lays out an epic critic step', async () => {
    const task = await tasks.create({ prompt: 'p' });
    const workspaceId = task.workspaceId!;
    const archive = archiveFor();
    const [d1, d2] = await Promise.all([archive.ensureEpic(workspaceId, 42), archive.ensureEpic(workspaceId, 42)]);
    expect(d1).toBe(d2);
    expect(d1).toBe(join(dir, 'archive', 'default', 'epic-42'));
    const manifest = JSON.parse(readFileSync(join(d1, 'archive.json'), 'utf8'));
    expect(manifest).toMatchObject({ epicRef: 42, workspace: 'Default', workspaceId, title: 'Epic #42', dispositions: [], exports: [] });
    expect(typeof manifest.createdAt).toBe('string');
    writeFileSync(join(d1, 'archive.json'), '{"custom":true}');
    await archive.ensureEpic(workspaceId, 42);
    expect(readFileSync(join(d1, 'archive.json'), 'utf8')).toBe('{"custom":true}');
    expect(readdirSync(d1).filter((n) => n.endsWith('.tmp'))).toEqual([]);

    const writer = archive.epicCriticStep(workspaceId, 42, 3, 'critic-x');
    writer.appendPrompt('epic prompt');
    writer.appendUpdate({ n: 1 });
    await writer.close();
    const stepDir = join(d1, 'attempts', '3', 'verification', 'pre-merge', 'critic-x');
    expect(await writer.dir).toBe(stepDir);
    expect(readFileSync(join(stepDir, 'prompt.md'), 'utf8')).toBe('epic prompt');
    expect(JSON.parse(readFileSync(join(stepDir, 'acp.jsonl'), 'utf8')).update).toEqual({ n: 1 });
  });
});
