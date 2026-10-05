import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

describe('VerificationAttemptStore.backfillFullOutputKeys', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-verify-backfill-'));
  let store: VerificationAttemptStore;
  let attemptId: number;

  const add = async (mechanism: 'command' | 'critic', output: string) =>
    (await store.append(attemptId, { mechanism, inputOid: 'a'.repeat(40), verdict: 'fail', summary: 's', output })).id;

  beforeAll(async () => {
    const asyncDb = await openAsyncDb(root);
    await seedWorkspace(asyncDb);
    const settingsStore = await makeSettingsStore(root);
    const tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    const task = await tasks.create({ prompt: 'backfill', state: 'ready' });
    attemptId = (await new AttemptStore(asyncDb).create(task.id)).id;
    store = new VerificationAttemptStore(asyncDb);
  });

  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
  });

  it('moves the legacy embedded path into the column, strips it from output, leaves a path it cannot key untouched, and is idempotent', async () => {
    const legacy = await add('command', 'head\n…[truncated 300000 chars; full output: /data/archive/1-a/attempts/2/verification/pre-merge/cmd-1/output.log]…\ntail');
    const windows = await add('command', 'h…[truncated 9 chars; full output: C:\\data\\archive\\1-a\\attempts\\2\\verification\\post-merge\\cmd-2\\output.log]…t');
    const foreign = await add('command', 'x…[truncated 1 chars; full output: /elsewhere/output.log]…y');
    const plain = await add('command', 'short output');
    const critic = await add('critic', 'review text mentioning full output: nothing');

    await store.backfillFullOutputKeys();
    const snapshot = async () => Promise.all([legacy, windows, foreign, plain, critic].map(async (id) => store.get(id)));
    const first = await snapshot();

    expect(first[0]).toMatchObject({ output: 'head\n…[truncated 300000 chars]…\ntail', fullOutputKey: 'verification/pre-merge/cmd-1/output.log' });
    expect(first[1]).toMatchObject({ output: 'h…[truncated 9 chars]…t', fullOutputKey: 'verification/post-merge/cmd-2/output.log' });
    expect(first[2]).toMatchObject({ output: 'x…[truncated 1 chars; full output: /elsewhere/output.log]…y', fullOutputKey: null });
    expect(first[3]).toMatchObject({ output: 'short output', fullOutputKey: null });
    expect(first[4]).toMatchObject({ output: 'review text mentioning full output: nothing', fullOutputKey: null });

    await store.backfillFullOutputKeys();
    expect(await snapshot()).toEqual(first);
  });

  it('runs once: a later boot touches nothing, even a row that now matches', async () => {
    const late = await add('command', 'a…[truncated 1 chars; full output: /d/verification/pre-merge/late/output.log]…b');
    await store.backfillFullOutputKeys();
    expect(await store.get(late)).toMatchObject({ fullOutputKey: null, output: expect.stringContaining('full output:') });
  });

  it('pages through more rows than one page holds', async () => {
    const fresh = await openAsyncDb(mkdtempSync(join(tmpdir(), 'harmonic-verify-backfill-paged-')));
    await seedWorkspace(fresh);
    const tasks = new TaskService(fresh, () => baselineConfig(), allWorkspaces(fresh, await makeSettingsStore(root)));
    const task = await tasks.create({ prompt: 'paged', state: 'ready' });
    const attempt = (await new AttemptStore(fresh).create(task.id)).id;
    const paged = new VerificationAttemptStore(fresh);
    const ids: number[] = [];
    for (let i = 0; i < 250; i += 1) {
      const output = i % 5 === 0 ? 'plain, mentions full output: nothing parseable' : `h…[truncated 5 chars; full output: /d/verification/pre-merge/s${i}/output.log]…t`;
      ids.push((await paged.append(attempt, { mechanism: 'command', inputOid: 'a'.repeat(40), verdict: 'fail', summary: 's', output })).id);
    }
    await paged.backfillFullOutputKeys();
    const rows = await Promise.all(ids.map((id) => paged.get(id)));
    rows.forEach((row, i) => {
      if (i % 5 === 0) expect(row).toMatchObject({ fullOutputKey: null, output: 'plain, mentions full output: nothing parseable' });
      else expect(row).toMatchObject({ fullOutputKey: `verification/pre-merge/s${i}/output.log`, output: 'h…[truncated 5 chars]…t' });
    });
  });
});
