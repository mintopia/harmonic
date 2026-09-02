import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { openAsyncDb } from '../src/db/async.js';
import * as schema from '../src/db/schema.js';

const REPO_MIGRATIONS = join(import.meta.dirname, '..', 'drizzle');

describe('drizzle single-baseline schema (ADR-0001 #388, ADR-0007)', () => {
  it('is exactly one migration file', () => {
    const sql = readdirSync(REPO_MIGRATIONS).filter((f) => f.endsWith('.sql'));
    expect(sql).toEqual(['0000_baseline.sql']);
  });

  it('boots a fresh DB with the target-state tables and none of the retired ones', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-baseline-'));
    const db = await openAsyncDb(dataDir);
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const tableNames = (
      await sqlite.execute(`select name from sqlite_master where type = 'table'`)
    ).rows.map((row) => String(row.name));

    for (const present of [
      'tasks', 'attempts', 'steps', 'sessions', 'conversations', 'conversation_events',
      'task_dependencies', 'tracker_dismissals', 'verification_attempts', 'guardrail_events',
      'attempt_events', 'attempt_tool_calls', 'scheduled_jobs', 'settings', 'workspaces',
      'tracker_containers', 'epics',
    ]) {
      expect(tableNames, `expected table ${present}`).toContain(present);
    }
    for (const absent of [
      'runs', 'run_facts', 'run_events', 'run_tool_calls', 'merge_journal', 'turn_queue',
      'execution_chains', 'work_context_leases', 'work_context_lease_dispositions',
    ]) {
      expect(tableNames, `expected NO table ${absent}`).not.toContain(absent);
    }

    sqlite.close();
    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('attempts is the single execution ledger: reason round-trips and taskId FK is enforced', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-baseline-ledger-'));
    const db = await openAsyncDb(dataDir);

    const task = await db.write((d) => d.insert(schema.tasks).values({
      prompt: 'seed', workingDir: '/tmp/p', state: 'ready', createdAt: Date.now(), updatedAt: Date.now(),
    }).returning().get());
    const attempt = await db.write((d) => d.insert(schema.attempts).values({
      taskId: task.id, number: 1, state: 'failed', startedAt: Date.now(), endedAt: Date.now(), reason: 'guardrail-trip',
    }).returning().get());
    expect(attempt.reason).toBe('guardrail-trip');

    let fkError: unknown;
    try {
      await db.write((d) => d.insert(schema.attempts).values({ taskId: 999999, number: 1, startedAt: Date.now() }).run());
    } catch (err) {
      fkError = err;
    }
    expect((fkError as { cause?: { message?: string } })?.cause?.message).toMatch(/FOREIGN KEY constraint failed/);

    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('boot creates exactly one Default Workspace, idempotently across re-opens', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-baseline-backfill-'));
    const first = await openAsyncDb(dataDir);
    const second = await openAsyncDb(dataDir);
    const workspaces = await second.read((d) => d.select().from(schema.workspaces).all());
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({ name: 'Default' });
    await first.close();
    await second.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
