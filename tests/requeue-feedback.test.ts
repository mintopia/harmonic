import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
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

/**
 * The requeue half of retry continuation (issue #147): this suite drives
 * `TaskService` directly with no Runner/ACP, so it verifies how a requeue places
 * the operator's feedback (baked into a native prompt vs carried in the column)
 * — the input a continuation Run then runs. It has no dispatch and therefore no
 * Session to observe; the assertion that the requeued fix continues in the SAME
 * Session (session/load, not a cold session/new) lives in the dispatching sibling
 * `review.test.ts` ("a rejected task requeued and re-run continues in the SAME
 * Session"). The two together cover the requeue-continuation acceptance criterion.
 */
describe('requeue feedback — origin-aware placement', () => {
  let dir: string;
  let db: Db;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let wsId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-requeue-'));
    db = openDb(dir);
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(db));
    wsId = (await allWorkspaces(db)())[0]!.id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('bakes feedback into a native Task’s prompt, leaving the feedback column clear', async () => {
    const task = await tasks.create({ prompt: 'original prompt' });
    await tasks.setState(task.id, 'running');
    await tasks.setState(task.id, 'failed');

    const requeued = await tasks.requeue(task.id, '  do it differently  ');
    expect(requeued.state).toBe('ready');
    expect(requeued.prompt).toContain('original prompt');
    expect(requeued.prompt).toContain('do it differently');
    expect(requeued.feedback).toBeNull();
  });

  it('keeps a mirrored Task’s prompt pristine and carries feedback in the column', async () => {
    const [mirrored] = await mirrorScan(tasks, [ticket({ number: 100 })], wsId);
    const derivedPrompt = mirrored!.prompt;
    await tasks.setState(mirrored!.id, 'running');
    await tasks.setState(mirrored!.id, 'failed');

    const requeued = await tasks.requeue(mirrored!.id, 'try harder');
    expect(requeued.state).toBe('ready');
    expect(requeued.prompt).toBe(derivedPrompt); // untouched — no baked-in feedback
    expect(requeued.feedback).toBe('try harder');
  });

  it('mirrored feedback survives a re-poll (upsertMirrored never clears the column)', async () => {
    const [mirrored] = await mirrorScan(tasks, [ticket({ number: 100 })], wsId);
    await tasks.setState(mirrored!.id, 'running');
    await tasks.setState(mirrored!.id, 'failed');
    await tasks.requeue(mirrored!.id, 'try harder');

    // The ticket is still open — the next poll re-derives the prompt but must
    // leave the operator's feedback (and the ready state) in place.
    const [repolled] = await mirrorScan(tasks, [ticket({ number: 100 })], wsId);
    expect(repolled!.state).toBe('ready');
    expect(repolled!.feedback).toBe('try harder');
  });
});
