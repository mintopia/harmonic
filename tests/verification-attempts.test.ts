import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import { allWorkspaces } from './helpers.js';

/**
 * The append-only Verification attempt log store (issue #136, mirroring
 * `tests/run-facts.test.ts`'s template for `RunFactStore`, issue #112).
 */
describe('VerificationAttemptStore (issue #136)', () => {
  let dir: string;
  let db: Db;
  let attempts: VerificationAttemptStore;
  let runId: number;
  let otherRunId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-verification-attempts-'));
    db = openDb(dir);
    const tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    const runStore = new RunStore(db);
    attempts = new VerificationAttemptStore(db);

    const task = tasks.create({ prompt: 'verify me', state: 'ready' });
    runId = runStore.create(task.id).id;
    const otherTask = tasks.create({ prompt: 'separate log', state: 'ready' });
    otherRunId = runStore.create(otherTask.id).id;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('appends a critic attempt and reads it back, seq 1, phase defaulted to verifying', () => {
    const row = attempts.append(runId, {
      mechanism: 'critic',
      inputOid: 'a'.repeat(40),
      verdict: 'pass',
      summary: 'looks good',
      output: '{"verdict":"pass","summary":"looks good"}',
      mutated: false,
    });
    expect(row).toMatchObject({
      runId,
      seq: 1,
      mechanism: 'critic',
      inputOid: 'a'.repeat(40),
      verdict: 'pass',
      summary: 'looks good',
      phase: 'verifying',
      mutated: false,
    });

    const [back] = attempts.list(runId);
    expect(back).toEqual(row);
  });

  it('assigns a 1-based monotonic seq per Run, sequencing each Run independently', () => {
    attempts.append(runId, {
      mechanism: 'critic',
      inputOid: 'a'.repeat(40),
      verdict: 'pass',
      summary: 's1',
      output: 'o1',
      mutated: false,
    });
    const second = attempts.append(runId, {
      mechanism: 'critic',
      inputOid: 'b'.repeat(40),
      verdict: 'fail',
      summary: 's2',
      output: 'o2',
      mutated: false,
    });
    expect(second.seq).toBe(2);

    const other = attempts.append(otherRunId, {
      mechanism: 'critic',
      inputOid: 'c'.repeat(40),
      verdict: 'inconclusive',
      summary: 's3',
      output: 'o3',
      mutated: true,
    });
    expect(other.seq).toBe(1); // a fresh Run starts at 1 regardless of other Runs
  });

  it("list returns a Run's attempts in seq order, and only that Run's", () => {
    attempts.append(runId, {
      mechanism: 'critic',
      inputOid: 'a'.repeat(40),
      verdict: 'pass',
      summary: 's1',
      output: 'o1',
      mutated: false,
    });
    attempts.append(runId, {
      mechanism: 'critic',
      inputOid: 'a'.repeat(40),
      verdict: 'fail',
      summary: 's2',
      output: 'o2',
      mutated: false,
    });
    attempts.append(otherRunId, {
      mechanism: 'critic',
      inputOid: 'a'.repeat(40),
      verdict: 'pass',
      summary: 's3',
      output: 'o3',
      mutated: false,
    });

    const log = attempts.list(runId);
    expect(log.map((a) => a.seq)).toEqual([1, 2]);
    expect(log.map((a) => a.verdict)).toEqual(['pass', 'fail']);
  });

  it('the (run_id, seq) unique index rejects a duplicate seq (append-only integrity)', () => {
    attempts.append(runId, {
      mechanism: 'critic',
      inputOid: 'a'.repeat(40),
      verdict: 'pass',
      summary: 's1',
      output: 'o1',
      mutated: false,
    }); // seq 1

    // Force a raw duplicate seq against the same file — the store never does
    // this, but the index must guarantee no two attempts share a seq in a Run.
    const sqlite = new Database(join(dir, 'harmonic.db'));
    const insert = sqlite.prepare(
      `insert into verification_attempts (run_id, seq, ts, mechanism, input_oid, verdict, summary, output, phase, mutated)
       values (?, 1, ?, 'critic', ?, 'fail', 's', 'o', 'verifying', 0)`,
    );
    expect(() => insert.run(runId, Date.now(), 'b'.repeat(40))).toThrow(/UNIQUE constraint failed/);

    // A different seq for the same Run is fine.
    const insertSeq2 = sqlite.prepare(
      `insert into verification_attempts (run_id, seq, ts, mechanism, input_oid, verdict, summary, output, phase, mutated)
       values (?, 2, ?, 'critic', ?, 'fail', 's', 'o', 'verifying', 0)`,
    );
    expect(() => insertSeq2.run(runId, Date.now(), 'b'.repeat(40))).not.toThrow();
    sqlite.close();
  });

  it('mechanism reserves the "command" value for the sibling verifier ticket', () => {
    const row = attempts.append(runId, {
      mechanism: 'command',
      inputOid: 'a'.repeat(40),
      verdict: 'fail',
      summary: 'lint failed',
      output: 'eslint output...',
      mutated: false,
    });
    expect(row.mechanism).toBe('command');
  });
});
