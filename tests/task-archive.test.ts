import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
