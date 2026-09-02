import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { mirrorScan } from '../src/tracker/mirror.js';
import type { Ticket } from '../src/tracker/adapter.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

const ticket = (over: Partial<Ticket>): Ticket => ({
  number: 100,
  title: 'A ticket',
  state: 'open',
  body: 'the body',
  createdAt: '2026-08-07T00:00:00Z',
  closedAt: null,
  labels: ['ready-for-agent'],
  assignees: [],
  parent: null,
  blockedBy: [],
  blocking: [],
  comments: [],
  isMap: false,
  url: 'https://github.com/mintopia/harmonic/issues/100',
  ...over,
});

describe('requeue feedback — origin-aware placement', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let wsId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-requeue-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    wsId = (await allWorkspaces(asyncDb, settingsStore)())[0]!.id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('bakes feedback into a native Task’s prompt, leaving the feedback column clear', async () => {
    const task = await tasks.create({ prompt: 'original prompt' });
    await tasks.setState(task.id, 'working');
    await tasks.setState(task.id, 'escalated');

    const requeued = await tasks.requeue(task.id, '  do it differently  ');
    expect(requeued.state).toBe('ready');
    expect(requeued.prompt).toContain('original prompt');
    expect(requeued.prompt).toContain('do it differently');
    expect(requeued.feedback).toBeNull();
  });

  it('keeps a mirrored Task’s prompt pristine and carries feedback in the column', async () => {
    const [mirrored] = await mirrorScan(tasks, [ticket({ number: 100 })], wsId);
    const derivedPrompt = mirrored!.prompt;
    await tasks.setState(mirrored!.id, 'working');
    await tasks.setState(mirrored!.id, 'escalated');

    const requeued = await tasks.requeue(mirrored!.id, 'try harder');
    expect(requeued.state).toBe('ready');
    expect(requeued.prompt).toBe(derivedPrompt);
    expect(requeued.feedback).toBe('try harder');
  });

  it('mirrored feedback survives a re-poll (upsertMirrored never clears the column)', async () => {
    const [mirrored] = await mirrorScan(tasks, [ticket({ number: 100 })], wsId);
    await tasks.setState(mirrored!.id, 'working');
    await tasks.setState(mirrored!.id, 'escalated');
    await tasks.requeue(mirrored!.id, 'try harder');

    const [repolled] = await mirrorScan(tasks, [ticket({ number: 100 })], wsId);
    expect(repolled!.state).toBe('ready');
    expect(repolled!.feedback).toBe('try harder');
  });
});
