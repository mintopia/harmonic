import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baselineConfig } from '../src/config.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { SessionStore } from '../src/domain/sessions.js';
import { stepRunKind } from '../src/domain/step-run-kind.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkflowStepRunStore } from '../src/domain/workflow-step-runs.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

describe('stepRunKind', () => {
  it.each([
    ['rebase', 'rebase'], ['agent', 'agent'], ['run', 'check'], ['command', 'check'], ['post-merge-check', 'check'], ['verify', 'marker'],
    ['critic', 'critic'], ['merge', 'publish'], ['open-pr', 'publish'], ['artifact', 'publish'], ['close-ticket', 'tracker'], ['comment', 'tracker'], ['cleanup', 'cleanup'],
  ])('%s -> %s', (action, kind) => expect(stepRunKind(action)).toBe(kind));
});

describe('WorkflowStepRunStore Attempt records', () => {
  let dir: string;
  let db: AsyncDbHandle;
  let store: WorkflowStepRunStore;
  let taskId: number;
  let attemptIds: number[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-step-run-store-'));
    db = await openAsyncDb(dir);
    await seedWorkspace(db);
    const tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, await makeSettingsStore(dir)));
    const attempts = new AttemptStore(db);
    taskId = (await tasks.create({ prompt: 'p' })).id;
    const first = await attempts.create(taskId);
    await attempts.update(first.id, { state: 'failed' });
    attemptIds = [first.id, (await attempts.create(taskId)).id];
    store = new WorkflowStepRunStore(db);
  });
  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const start = (stepId: string, attemptId: number) => store.start({ taskId, workflowRef: 'w@1', stepId, position: 0, action: 'run', attemptId });

  it('lists step runs per Attempt in start order and finds the latest running one', async () => {
    const a1 = await start('a', attemptIds[0]!);
    await store.finish(a1.id, { outcome: 'pass', outputs: { stdout: '', exitCode: 0 }, summary: 'ok' });
    await start('b', attemptIds[0]!);
    const c = await start('c', attemptIds[0]!);
    const d = await start('d', attemptIds[1]!);
    expect((await store.listForAttempt(attemptIds[0]!)).map((r) => r.stepId)).toEqual(['a', 'b', 'c']);
    const running = await store.runningForAttempts(attemptIds);
    expect(running.get(attemptIds[0]!)?.id).toBe(c.id);
    expect(running.get(attemptIds[1]!)?.id).toBe(d.id);
    expect((await store.runningForAttempts([])).size).toBe(0);
  });

  it('sets session, harness, model and usage, leaving unset fields alone', async () => {
    const row = await start('a', attemptIds[0]!);
    const session = await new SessionStore(db).recordDispatch({ harness: 'claude', harnessSessionId: 's', model: 'm', cwd: '/w', workspaceId: null, mcpTemplates: [], capabilities: undefined, adapterVersion: 'x', now: 1 });
    await store.setSession(row.id, { harness: 'claude', model: 'm' });
    await store.setSession(row.id, { sessionRowId: session.id });
    await store.setUsage(row.id, { in: 1 });
    const [got] = await store.listForAttempt(attemptIds[0]!);
    expect(got).toMatchObject({ sessionRowId: session.id, harness: 'claude', model: 'm', usage: '{"in":1}' });
  });

  it('closeOrphans closes only unfinished runs', async () => {
    const done = await start('a', attemptIds[0]!);
    await store.finish(done.id, { outcome: 'fail', outputs: { stdout: '', exitCode: 1 }, summary: 'bad' });
    await start('b', attemptIds[1]!);
    expect(await store.closeOrphans(5)).toBe(1);
    expect((await store.listForAttempt(attemptIds[0]!))[0]).toMatchObject({ outcome: 'fail', summary: 'bad' });
    expect((await store.listForAttempt(attemptIds[1]!))[0]).toMatchObject({ outcome: 'inconclusive', summary: 'interrupted by process death', endedAt: 5 });
    expect(await store.closeOrphans()).toBe(0);
  });
});
