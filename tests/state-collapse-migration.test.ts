import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { openAsyncDb } from '../src/db/async.js';
import * as schema from '../src/db/schema.js';

const REPO_MIGRATIONS = join(import.meta.dirname, '..', 'drizzle');

/** A migrations folder frozen just before `boundary`, built from the repo's real migrations. */
function migrationsFolderBefore(boundary: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-migrations-'));
  mkdirSync(join(dir, 'meta'));
  for (const file of readdirSync(REPO_MIGRATIONS)) {
    if (file.endsWith('.sql') && file < boundary) copyFileSync(join(REPO_MIGRATIONS, file), join(dir, file));
  }
  for (const file of readdirSync(join(REPO_MIGRATIONS, 'meta'))) {
    if (file.endsWith('_snapshot.json') && file < boundary) {
      copyFileSync(join(REPO_MIGRATIONS, 'meta', file), join(dir, 'meta', file));
    }
  }
  const journal = JSON.parse(readFileSync(join(REPO_MIGRATIONS, 'meta', '_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < boundary);
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  return dir;
}

/**
 * Migration 0052 (ADR-0041, #314) maps the old ticket states onto the collapsed
 * enum from the rows' recorded facts, and drops the review-gate and Drive
 * columns. Every old state × escalated-flag combination an upgraded install can
 * hold is seeded on a real pre-0052 schema and read back through the head.
 */
describe('state collapse migration (0052, ADR-0041)', () => {
  it('maps every pre-ADR-0041 state × escalated combination, backfills reasons, rewrites facts, and drops the retired columns', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-collapse-migrate-'));
    const migrationsFolder = migrationsFolderBefore('0052');
    const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await client.execute('PRAGMA foreign_keys = ON');
    await migrate(drizzle(client, { schema }), { migrationsFolder });

    const now = Date.now();
    await client.execute({
      sql: `insert into workspaces (name, working_dir, tracker_enabled, tracker_poll_interval_seconds, created_at, updated_at, verification_auto_accept)
         values ('Legacy', '/tmp/legacy-project', 0, 60, ?, ?, 1)`,
      args: [now, now],
    });
    const insertTask = async (prompt: string, state: string, escalated: number, drive: string | null): Promise<number> => {
      const row = await client.execute({
        sql: `insert into tasks (prompt, working_dir, state, workspace_id, origin, drive, escalated, created_at, updated_at)
           values (?, '/tmp/legacy-project', ?, 1, 'native', ?, ?, ?, ?) returning id`,
        args: [prompt, state, drive, escalated, now, now],
      });
      return Number(row.rows[0]!['id']);
    };
    const insertRun = async (taskId: number, state: string, phase: string, reason: string | null, extra: Record<string, unknown> = {}): Promise<number> => {
      const row = await client.execute({
        sql: `insert into runs (task_id, attempt, state, phase, reason, started_at, review_deadline, review, review_feedback, reviewed_at)
           values (?, 1, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        args: [taskId, state, phase, reason, now, (extra['reviewDeadline'] as number | null) ?? null, (extra['review'] as string | null) ?? null, null, null],
      });
      return Number(row.rows[0]!['id']);
    };
    const insertAttempt = (taskId: number, state: string) =>
      client.execute({ sql: 'insert into attempts (task_id, number, state, started_at) values (?, 1, ?, ?)', args: [taskId, state, now] });
    const insertFact = (runId: number, type: string, payload: Record<string, unknown>) =>
      client.execute({ sql: 'insert into run_facts (run_id, seq, ts, type, payload) values (?, 1, ?, ?, ?)', args: [runId, now, type, JSON.stringify(payload)] });

    const draft = await insertTask('draft', 'draft', 0, null);
    const ready = await insertTask('ready', 'ready', 0, 'afk');
    const readyEscalated = await insertTask('ready+escalated', 'ready', 1, 'hitl');
    const readyEscalatedRun = await insertRun(readyEscalated, 'failed', 'terminal', 'escalated to human: attempt 2 of 2 failed');
    await insertFact(readyEscalatedRun, 'escalate', { runState: 'failed', taskAction: 'escalate', reason: 'escalated to human: attempt 2 of 2 failed' });
    const running = await insertTask('running', 'running', 0, 'afk');
    await insertRun(running, 'running', 'executing', null);
    const awaiting = await insertTask('awaiting-review', 'awaiting-review', 0, null);
    const parkedRun = await insertRun(awaiting, 'running', 'review', null, { reviewDeadline: now + 1000 });
    await insertFact(parkedRun, 'agent-finish/unresolved', { runState: 'completed', taskAction: 'awaiting-review', reason: null });
    const completed = await insertTask('completed', 'completed', 0, 'afk');
    const failedWithHistory = await insertTask('failed with attempts', 'failed', 0, 'afk');
    await insertAttempt(failedWithHistory, 'failed');
    const failedRun = await insertRun(failedWithHistory, 'failed', 'terminal', 'harness exited (code 1)');
    await insertFact(failedRun, 'failed', { runState: 'failed', taskAction: 'failed', reason: 'harness exited (code 1)' });
    const failedBare = await insertTask('failed without attempts', 'failed', 0, 'hitl');
    const cancelled = await insertTask('cancelled', 'cancelled', 0, null);
    await client.execute({
      sql: `insert into sessions (harness, harness_session_id, model, cwd, capability_snapshot, status, retire_reason, created_at, updated_at, last_active_at)
         values ('claude', 's-1', 'm', '/tmp/legacy-project', '{}', 'retired', 'reject-continuation-timeout', ?, ?, ?)`,
      args: [now, now, now],
    });
    client.close();

    // Boot to head applies 0052.
    const db = await openAsyncDb(dataDir);
    const tasks = await db.read((d) => d.select().from(schema.tasks).all());
    const byId = new Map(tasks.map((t) => [t.id, t]));
    expect(byId.get(draft)).toMatchObject({ state: 'draft', escalationReason: null });
    expect(byId.get(ready)).toMatchObject({ state: 'ready', escalationReason: null });
    expect(byId.get(readyEscalated)).toMatchObject({ state: 'escalated', escalationReason: 'escalated to human: attempt 2 of 2 failed' });
    expect(byId.get(running)).toMatchObject({ state: 'working', escalationReason: null });
    expect(byId.get(awaiting)).toMatchObject({ state: 'escalated', escalationReason: expect.stringContaining('awaiting human review') });
    expect(byId.get(completed)).toMatchObject({ state: 'done', escalationReason: null });
    expect(byId.get(failedWithHistory)).toMatchObject({ state: 'escalated', escalationReason: 'harness exited (code 1)' });
    expect(byId.get(failedBare)).toMatchObject({ state: 'ready', escalationReason: null });
    expect(byId.get(cancelled)).toMatchObject({ state: 'cancelled', escalationReason: null });
    for (const task of tasks) {
      expect(task).not.toHaveProperty('drive');
      expect(task).not.toHaveProperty('escalated');
      expect(schema.TASK_STATES).toContain(task.state);
    }

    // The review-parked Run is closed as the completed work it was; the review columns are gone.
    const runs = await db.read((d) => d.select().from(schema.runs).all());
    const parked = runs.find((r) => r.id === parkedRun)!;
    expect(parked).toMatchObject({ state: 'completed' });
    expect(parked.finishedAt).not.toBeNull();
    expect(parked).not.toHaveProperty('reviewDeadline');
    expect(parked).not.toHaveProperty('review');

    // The retired workspace knob and session reasons are gone.
    const [workspace] = await db.read((d) => d.select().from(schema.workspaces).all());
    expect(workspace).not.toHaveProperty('verificationAutoAccept');
    const [session] = await db.read((d) => d.select().from(schema.sessions).all());
    expect(session!.retireReason).toBe('retention-ttl');

    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(migrationsFolder, { recursive: true, force: true });
  });
});
