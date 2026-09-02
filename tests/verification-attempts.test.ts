import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

describe('VerificationAttemptStore (issue #136)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let attempts: VerificationAttemptStore;
  let attemptId: number;
  let otherAttemptId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-verification-attempts-'));
    asyncDb = await openAsyncDb(dir);
    const settingsStore = await makeSettingsStore(dir);
    const tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    const attemptStore = new AttemptStore(asyncDb);
    attempts = new VerificationAttemptStore(asyncDb);

    const task = await tasks.create({ prompt: 'verify me', state: 'ready' });
    attemptId = (await attemptStore.create(task.id)).id;
    const otherTask = await tasks.create({ prompt: 'separate log', state: 'ready' });
    otherAttemptId = (await attemptStore.create(otherTask.id)).id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends a critic attempt and reads it back, seq 1', async () => {
    const row = await attempts.append(attemptId, {
      mechanism: 'critic',
      inputOid: 'a'.repeat(40),
      verdict: 'pass',
      summary: 'looks good',
      output: '{"verdict":"pass","summary":"looks good"}',
    });
    expect(row).toMatchObject({
      attemptId,
      seq: 1,
      mechanism: 'critic',
      inputOid: 'a'.repeat(40),
      verdict: 'pass',
      summary: 'looks good',
    });

    const [back] = await attempts.list(attemptId);
    expect(back).toEqual(row);
  });

  it('assigns a 1-based monotonic seq per Run, sequencing each Run independently', async () => {
    await attempts.append(attemptId, {
      mechanism: 'critic',
      inputOid: 'a'.repeat(40),
      verdict: 'pass',
      summary: 's1',
      output: 'o1',
    });
    const second = await attempts.append(attemptId, {
      mechanism: 'critic',
      inputOid: 'b'.repeat(40),
      verdict: 'fail',
      summary: 's2',
      output: 'o2',
    });
    expect(second.seq).toBe(2);

    const other = await attempts.append(otherAttemptId, {
      mechanism: 'critic',
      inputOid: 'c'.repeat(40),
      verdict: 'inconclusive',
      summary: 's3',
      output: 'o3',
    });
    expect(other.seq).toBe(1);
  });

  it("list returns a Run's attempts in seq order, and only that Run's", async () => {
    await attempts.append(attemptId, {
      mechanism: 'critic',
      inputOid: 'a'.repeat(40),
      verdict: 'pass',
      summary: 's1',
      output: 'o1',
    });
    await attempts.append(attemptId, {
      mechanism: 'critic',
      inputOid: 'a'.repeat(40),
      verdict: 'fail',
      summary: 's2',
      output: 'o2',
    });
    await attempts.append(otherAttemptId, {
      mechanism: 'critic',
      inputOid: 'a'.repeat(40),
      verdict: 'pass',
      summary: 's3',
      output: 'o3',
    });

    const log = await attempts.list(attemptId);
    expect(log.map((a) => a.seq)).toEqual([1, 2]);
    expect(log.map((a) => a.verdict)).toEqual(['pass', 'fail']);
  });

  it('the (attempt_id, seq) unique index rejects a duplicate seq (append-only integrity)', async () => {
    await attempts.append(attemptId, {
      mechanism: 'critic',
      inputOid: 'a'.repeat(40),
      verdict: 'pass',
      summary: 's1',
      output: 'o1',
    });

    const raw = createClient({ url: `file:${join(dir, 'harmonic.db')}` });
    await expect(
      raw.execute({
        sql: `insert into verification_attempts (attempt_id, seq, ts, mechanism, input_oid, verdict, summary, output)
       values (?, 1, ?, 'critic', ?, 'fail', 's', 'o')`,
        args: [attemptId, Date.now(), 'b'.repeat(40)],
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/);

    await expect(
      raw.execute({
        sql: `insert into verification_attempts (attempt_id, seq, ts, mechanism, input_oid, verdict, summary, output)
       values (?, 2, ?, 'critic', ?, 'fail', 's', 'o')`,
        args: [attemptId, Date.now(), 'b'.repeat(40)],
      }),
    ).resolves.toBeDefined();
    raw.close();
  });

  it('round-trips the critic transcript locator, defaulting both columns to null', async () => {
    const withLocator = await attempts.append(attemptId, {
      mechanism: 'critic',
      inputOid: 'a'.repeat(40),
      verdict: 'pass',
      summary: 'looks good',
      output: 'o',
      transcriptPath: '/home/u/.claude/projects/x/sess.jsonl',
      harness: 'claude',
    });
    expect(withLocator).toMatchObject({ transcriptPath: '/home/u/.claude/projects/x/sess.jsonl', harness: 'claude' });
    expect(await attempts.get(withLocator.id)).toEqual(withLocator);

    const noLocator = await attempts.append(attemptId, {
      mechanism: 'command',
      inputOid: 'a'.repeat(40),
      verdict: 'pass',
      summary: 'ok',
      output: 'o',
    });
    expect(noLocator).toMatchObject({ transcriptPath: null, harness: null });
  });

  it('mechanism reserves the "command" value for the sibling verifier ticket', async () => {
    const row = await attempts.append(attemptId, {
      mechanism: 'command',
      inputOid: 'a'.repeat(40),
      verdict: 'fail',
      summary: 'lint failed',
      output: 'eslint output...',
    });
    expect(row.mechanism).toBe('command');
  });
});
