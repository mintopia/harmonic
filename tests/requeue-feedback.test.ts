import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { mirrorScan } from '../src/tracker/mirror.js';
import type { Ticket } from '../src/tracker/adapter.js';
import { allWorkspaces } from './helpers.js';

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
  let db: Db;
  let tasks: TaskService;
  let wsId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-requeue-'));
    db = openDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    wsId = allWorkspaces(db)()[0]!.id;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('bakes feedback into a native Task’s prompt, leaving the feedback column clear', () => {
    const task = tasks.create({ prompt: 'original prompt' });
    tasks.setState(task.id, 'running');
    tasks.setState(task.id, 'failed');

    const requeued = tasks.requeue(task.id, '  do it differently  ');
    expect(requeued.state).toBe('ready');
    expect(requeued.prompt).toContain('original prompt');
    expect(requeued.prompt).toContain('do it differently');
    expect(requeued.feedback).toBeNull();
  });

  it('keeps a mirrored Task’s prompt pristine and carries feedback in the column', () => {
    const [mirrored] = mirrorScan(tasks, [ticket({ number: 100 })], wsId);
    const derivedPrompt = mirrored!.prompt;
    tasks.setState(mirrored!.id, 'running');
    tasks.setState(mirrored!.id, 'failed');

    const requeued = tasks.requeue(mirrored!.id, 'try harder');
    expect(requeued.state).toBe('ready');
    expect(requeued.prompt).toBe(derivedPrompt); // untouched — no baked-in feedback
    expect(requeued.feedback).toBe('try harder');
  });

  it('mirrored feedback survives a re-poll (upsertMirrored never clears the column)', () => {
    const [mirrored] = mirrorScan(tasks, [ticket({ number: 100 })], wsId);
    tasks.setState(mirrored!.id, 'running');
    tasks.setState(mirrored!.id, 'failed');
    tasks.requeue(mirrored!.id, 'try harder');

    // The ticket is still open — the next poll re-derives the prompt but must
    // leave the operator's feedback (and the ready state) in place.
    const [repolled] = mirrorScan(tasks, [ticket({ number: 100 })], wsId);
    expect(repolled!.state).toBe('ready');
    expect(repolled!.feedback).toBe('try harder');
  });
});
