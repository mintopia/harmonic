import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
      'attempt_events', 'task_events', 'attempt_tool_calls', 'scheduled_jobs', 'settings', 'workspaces',
      'tracker_containers', 'epics', 'agent_messages',
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

  it('boot seeds no Workspace, idempotently across re-opens (first-run onboarding adds the first one)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-baseline-backfill-'));
    const first = await openAsyncDb(dataDir);
    const second = await openAsyncDb(dataDir);
    const workspaces = await second.read((d) => d.select().from(schema.workspaces).all());
    expect(workspaces).toHaveLength(0);
    await first.close();
    await second.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('converges a DB seeded with integer tracker refs: refs survive as strings and the unique index still holds', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-baseline-refs-'));
    const legacy = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const oldBaseline = readFileSync(join(import.meta.dirname, 'fixtures', 'baseline-integer-tracker-refs.sql'), 'utf8');
    for (const statement of oldBaseline.split('--> statement-breakpoint')) {
      if (statement.trim()) await legacy.execute(statement);
    }
    const now = Date.now();
    await legacy.execute({ sql: `insert into workspaces (id, name, working_dir, created_at, updated_at) values (1, 'w', '/tmp/w', ?, ?)`, args: [now, now] });
    await legacy.execute({ sql: `insert into tasks (prompt, working_dir, state, created_at, updated_at, workspace_id, tracker_ref, tracker_parent) values ('t', '/tmp/w', 'ready', ?, ?, 1, 185, 42)`, args: [now, now] });
    await legacy.execute({ sql: `insert into tracker_dismissals (workspace_id, tracker_ref, dismissed_at) values (1, 7, ?)`, args: [now] });
    await legacy.execute({ sql: `insert into epics (workspace_id, tracker_ref, kind, state, member_refs) values (1, 42, 'spec', 'open', '[185]')`, args: [] });
    legacy.close();

    const db = await openAsyncDb(dataDir);
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const task = (await sqlite.execute(`select tracker_ref, typeof(tracker_ref) as t, tracker_parent, typeof(tracker_parent) as p from tasks`)).rows[0]!;
    expect([task.tracker_ref, task.t, task.tracker_parent, task.p]).toEqual(['185', 'text', '42', 'text']);
    const dismissal = (await sqlite.execute(`select tracker_ref, typeof(tracker_ref) as t from tracker_dismissals`)).rows[0]!;
    expect([dismissal.tracker_ref, dismissal.t]).toEqual(['7', 'text']);
    const epic = (await sqlite.execute(`select tracker_ref, typeof(tracker_ref) as t from epics`)).rows[0]!;
    expect([epic.tracker_ref, epic.t]).toEqual(['42', 'text']);
    sqlite.close();

    await expect(db.write((d) => d.insert(schema.tasks).values({
      prompt: 'dup', workingDir: '/tmp/w', state: 'ready', createdAt: now, updatedAt: now, workspaceId: 1, trackerRef: '185' as never,
    }).run())).rejects.toThrow();
    await db.write((d) => d.insert(schema.tasks).values({
      prompt: 'jira', workingDir: '/tmp/w', state: 'ready', createdAt: now, updatedAt: now, workspaceId: 1, trackerRef: 'PROJ-185' as never,
    }).run());

    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
