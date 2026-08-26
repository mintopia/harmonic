import { describe, it, expect, afterEach } from 'vitest';
import { createClient } from '@libsql/client';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { workContextKey } from '../src/domain/work-context-key.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed README, mirroring
 * crash-recovery.test.ts's `makeRepo` — a real, clean, on-branch context for
 * the direct-mode lease reconciliation tests (issue #123). */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-boot-recovery-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/**
 * Boot crash-recovery: a fresh process executes nothing, so any Task left
 * `running` by the previous instance was orphaned by the restart and must be
 * failed — including a mirrored afk Task that crashed between the ready→running
 * flip (the lock) and its Run being created. That one has no orphaned Run row
 * for the run sweep to mark, and the poll refuses to move a Task off `running`,
 * so before this sweep it stayed stuck `running` forever while its ticket
 * stayed open.
 */
describe('boot crash-recovery', () => {
  let server: TestServer;

  afterEach(async () => {
    await server.close();
  });

  it('fails a Task stuck `running` with no Run row on the next boot', async () => {
    server = await startServer();
    const created = await server.api('POST', '/api/tasks', { prompt: 'stuck mid-launch' });
    const id = created.body.id as number;
    const dataDir = server.dataDir;

    // Simulate the crash: the auto-runner had flipped it to `running` but died
    // before spawning a Run — so there is no `running` run for the run sweep.
    await server.app.close();
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute({ sql: 'UPDATE tasks SET state = ? WHERE id = ?', args: ['running', id] });
    sqlite.close();

    server = await startServer(undefined, { dataDir });
    const recovered = await server.api('GET', `/api/tasks/${id}`);
    expect(recovered.body.state).toBe('failed');
  });

  it('leaves a review-parked native Run untouched across a restart (issue #114)', async () => {
    // A Run parked in `phase:'review'` is `state:'running'` but has no live
    // process — the review gate is defined by having none. Crash recovery must
    // NOT fail it (each phase survives a restart), unlike an executing orphan.
    server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ stopReason: 'end_turn' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done');
    const dataDir = server.dataDir;

    await server.app.close();
    server = await startServer(stubHarness(), { dataDir });

    const task = await server.api('GET', `/api/tasks/${created.body.id}`);
    expect(task.body.state).toBe('escalated'); // survived, not failed
    const run = await server.api('GET', `/api/runs/${started.body.id}`);
    expect(run.body.state).toBe('running');
    expect(run.body.phase).toBe('terminal');
  });

  it('sweeps a review-parked Run past its SLA to a terminal disposition at boot, via a run_fact (issue #114)', async () => {
    server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ stopReason: 'end_turn' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done');
    const dataDir = server.dataDir;
    const runId = started.body.id as number;

    // Force the review SLA into the past (an abandoned review), then reboot.
    await server.app.close();
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute({ sql: 'UPDATE runs SET review_deadline = ? WHERE id = ?', args: [1, runId] });
    sqlite.close();
    server = await startServer(stubHarness(), { dataDir });

    // The boot sweep settled it to a terminal disposition: Run failed (phase
    // terminal), Task failed — the review-sla-expiry disposition won.
    const run = await server.api('GET', `/api/runs/${runId}`);
    expect(run.body.state).toBe('failed');
    expect(run.body.phase).toBe('terminal');
    expect(run.body.reason).toContain('review SLA expired');
    expect((await server.api('GET', `/api/tasks/${created.body.id}`)).body.state).toBe('failed');

    // It appears as a `run_fact` resolved by the coordinator, not a bare state write.
    const check = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const fact = (
      await check.execute({
        sql: 'SELECT type FROM run_facts WHERE run_id = ? AND type = ?',
        args: [runId, 'review-sla-expiry'],
      })
    ).rows[0];
    check.close();
    expect(fact).toBeTruthy();
  });

  it('reconciles a Run crashed mid-landing whose effect already applied — completes it without re-merging or duplicating the journal (issue #117, AC1/AC5)', async () => {
    server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ stopReason: 'end_turn' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done');
    const dataDir = server.dataDir;
    const runId = started.body.id as number;
    const taskId = created.body.id as number;

    // Simulate the crash: the process died right after the merge landed and
    // its result was journaled, but before the finishing settle ran.
    await server.app.close();
    const branch = 'run-branch';
    const baseBranch = 'main';
    const idempotencyKey = `${baseBranch}<-${branch}`;
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute({ sql: "UPDATE runs SET phase = 'landing', branch = ?, base_branch = ? WHERE id = ?", args: [branch, baseBranch, runId] });
    // Same fact type `LandingCoordinator.land()` writes at its step 2, before
    // the PONC (landing-coordinator.ts's `LAND_FACT_TYPE`).
    await sqlite.execute({
      sql: 'INSERT INTO run_facts (run_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)',
      args: [runId, 1, Date.now(), 'agent-finish/unresolved', JSON.stringify({ runState: 'completed', taskAction: 'completed', reason: null })],
    });
    await sqlite.execute({
      sql: 'INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [runId, 1, Date.now(), 'ponc', null, null, JSON.stringify({ cutoffSeq: 1 })],
    });
    await sqlite.execute({
      sql: 'INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [runId, 2, Date.now(), 'intent', 'target-ref', idempotencyKey, JSON.stringify({ expected: { baseBranch, branch } })],
    });
    await sqlite.execute({
      sql: 'INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [runId, 3, Date.now(), 'result', 'target-ref', idempotencyKey, JSON.stringify({ ok: true, observed: { baseBranch, branch } })],
    });
    sqlite.close();

    server = await startServer(stubHarness(), { dataDir });

    // The boot sweep completed the landing exactly as `land()` itself would
    // have, without touching git (the journal already showed it applied).
    const run = await server.api('GET', `/api/runs/${runId}`);
    expect(run.body.state).toBe('completed');
    expect(run.body.phase).toBe('terminal');
    expect(run.body.review).toBe('accepted');
    const task = await server.api('GET', `/api/tasks/${taskId}`);
    expect(task.body.state).toBe('done');

    // No duplicate/re-applied result for the already-applied effect.
    const check = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const results = (
      await check.execute({
        sql: "SELECT COUNT(*) as n FROM landing_journal WHERE run_id = ? AND kind = 'result' AND idempotency_key = ?",
        args: [runId, idempotencyKey],
      })
    ).rows[0] as unknown as {n: number };
    check.close();
    expect(results.n).toBe(1);
  });

  it('is idempotent across repeated boots once a mid-landing reconcile completes (issue #117, AC4)', async () => {
    server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ stopReason: 'end_turn' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done');
    const dataDir = server.dataDir;
    const runId = started.body.id as number;

    await server.app.close();
    const branch = 'run-branch';
    const baseBranch = 'main';
    const idempotencyKey = `${baseBranch}<-${branch}`;
    let sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute({ sql: "UPDATE runs SET phase = 'landing', branch = ?, base_branch = ? WHERE id = ?", args: [branch, baseBranch, runId] });
    await sqlite.execute({
      sql: 'INSERT INTO run_facts (run_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)',
      args: [runId, 1, Date.now(), 'agent-finish/unresolved', JSON.stringify({ runState: 'completed', taskAction: 'completed', reason: null })],
    });
    await sqlite.execute({
      sql: 'INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [runId, 1, Date.now(), 'ponc', null, null, JSON.stringify({ cutoffSeq: 1 })],
    });
    await sqlite.execute({
      sql: 'INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [runId, 2, Date.now(), 'intent', 'target-ref', idempotencyKey, JSON.stringify({ expected: { baseBranch, branch } })],
    });
    await sqlite.execute({
      sql: 'INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [runId, 3, Date.now(), 'result', 'target-ref', idempotencyKey, JSON.stringify({ ok: true, observed: { baseBranch, branch } })],
    });
    sqlite.close();

    server = await startServer(stubHarness(), { dataDir });
    expect((await server.api('GET', `/api/runs/${runId}`)).body.state).toBe('completed');

    await server.app.close();
    sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const factCount = ((await sqlite.execute({ sql: 'SELECT COUNT(*) as n FROM run_facts WHERE run_id = ?', args: [runId] })).rows[0] as unknown as {n: number }).n;
    const journalCount = ((await sqlite.execute({ sql: 'SELECT COUNT(*) as n FROM landing_journal WHERE run_id = ?', args: [runId] })).rows[0] as unknown as {n: number }).n;
    sqlite.close();

    // A second boot: the Run already left `state:'running'`, so `listLandingOrphans`
    // no longer selects it — nothing for this sweep to do.
    server = await startServer(stubHarness(), { dataDir });
    expect((await server.api('GET', `/api/runs/${runId}`)).body.state).toBe('completed');

    sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const factCount2 = ((await sqlite.execute({ sql: 'SELECT COUNT(*) as n FROM run_facts WHERE run_id = ?', args: [runId] })).rows[0] as unknown as {n: number }).n;
    const journalCount2 = ((await sqlite.execute({ sql: 'SELECT COUNT(*) as n FROM landing_journal WHERE run_id = ?', args: [runId] })).rows[0] as unknown as {n: number }).n;
    sqlite.close();
    expect(factCount2).toBe(factCount);
    expect(journalCount2).toBe(journalCount);
  });

  it('reconciles all three stores together in one boot sweep — facts, journal, and queue for the same mid-landing Run (issue #117, AC1)', async () => {
    server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ stopReason: 'end_turn' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done');
    const dataDir = server.dataDir;
    const runId = started.body.id as number;
    const taskId = created.body.id as number;

    // Seed an inconsistent mid-landing state across all THREE stores at once
    // (issue #117 AC1): run_facts + landing_journal already show a completed
    // landing (same seed as the mid-landing test above), AND the turn_queue
    // still has a stale pending (non-mutating) `continue` turn for this same
    // Run that a live process never got to sweep before the crash.
    await server.app.close();
    const branch = 'run-branch';
    const baseBranch = 'main';
    const idempotencyKey = `${baseBranch}<-${branch}`;
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute({ sql: "UPDATE runs SET phase = 'landing', branch = ?, base_branch = ? WHERE id = ?", args: [branch, baseBranch, runId] });
    await sqlite.execute({
      sql: 'INSERT INTO run_facts (run_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)',
      args: [runId, 1, Date.now(), 'agent-finish/unresolved', JSON.stringify({ runState: 'completed', taskAction: 'completed', reason: null })],
    });
    await sqlite.execute({
      sql: 'INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [runId, 1, Date.now(), 'ponc', null, null, JSON.stringify({ cutoffSeq: 1 })],
    });
    await sqlite.execute({
      sql: 'INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [runId, 2, Date.now(), 'intent', 'target-ref', idempotencyKey, JSON.stringify({ expected: { baseBranch, branch } })],
    });
    await sqlite.execute({
      sql: 'INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [runId, 3, Date.now(), 'result', 'target-ref', idempotencyKey, JSON.stringify({ ok: true, observed: { baseBranch, branch } })],
    });
    await sqlite.execute({
      sql: `INSERT INTO turn_queue (session_id, run_id, seq, status, purpose, enqueued_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      args: ['sess-ac1', runId, 1, 'queued', 'continue', Date.now()],
    });
    sqlite.close();

    server = await startServer(stubHarness(), { dataDir });

    // Consistent, non-duplicating outcome: pass A completes the landing
    // exactly once, and pass B (same boot) sweeps the stale queued turn.
    const run = await server.api('GET', `/api/runs/${runId}`);
    expect(run.body.state).toBe('completed');
    expect(run.body.phase).toBe('terminal');
    const task = await server.api('GET', `/api/tasks/${taskId}`);
    expect(task.body.state).toBe('done');

    const check = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const results = (
      await check.execute({
        sql: "SELECT COUNT(*) as n FROM landing_journal WHERE run_id = ? AND kind = 'result' AND idempotency_key = ?",
        args: [runId, idempotencyKey],
      })
    ).rows[0] as unknown as {n: number };
    const turn = (
      await check.execute({ sql: 'SELECT status, cancel_reason as cancelReason FROM turn_queue WHERE run_id = ?', args: [runId] })
    ).rows[0] as unknown as {
      status: string;
      cancelReason: string;
    };
    check.close();
    expect(results.n).toBe(1); // no re-merge, no duplicate journal result
    expect(turn.status).toBe('cancelled');
    expect(turn.cancelReason).toBe('execution-closed');
  });

  it('escalates the Run for an ambiguous in-flight mutating turn interrupted by restart, and stays stable on a repeat boot (issue #117, AC2)', async () => {
    server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ stopReason: 'end_turn' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done');
    const dataDir = server.dataDir;
    const runId = started.body.id as number;
    const taskId = created.body.id as number;

    // Simulate the crash: a self-heal turn was in flight against this Run,
    // whose effect on the workspace is now unknown.
    await server.app.close();
    let sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute({ sql: "UPDATE runs SET state = 'running', phase = 'validating' WHERE id = ?", args: [runId] });
    await sqlite.execute({ sql: "UPDATE tasks SET state = 'running' WHERE id = ?", args: [taskId] });
    await sqlite.execute({
      sql: `INSERT INTO turn_queue (session_id, run_id, seq, status, purpose, expected_workspace_oid, expected_fingerprint, enqueued_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['sess-1', runId, 1, 'in_flight', 'self-heal', 'oid-1', 'fp-1', Date.now(), Date.now()],
    });
    sqlite.close();

    server = await startServer(stubHarness(), { dataDir });

    const run = await server.api('GET', `/api/runs/${runId}`);
    expect(run.body.state).toBe('failed');
    expect(run.body.phase).toBe('terminal');
    const task = await server.api('GET', `/api/tasks/${taskId}`);
    expect(task.body.state).toBe('escalated');
    expect(task.body.escalationReason).toContain('escalated to human');

    sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const escalateFacts = (await sqlite.execute({ sql: "SELECT COUNT(*) as n FROM run_facts WHERE run_id = ? AND type = 'escalate'", args: [runId] })).rows[0] as unknown as {n: number };
    const turn = (await sqlite.execute({ sql: 'SELECT status FROM turn_queue WHERE run_id = ?', args: [runId] })).rows[0] as unknown as {status: string };
    sqlite.close();
    expect(escalateFacts.n).toBe(1);
    expect(turn.status).toBe('failed');

    // A repeat boot must not throw or re-escalate: the turn is already
    // `failed` (excluded from `listUnsettled`), and the Run already left
    // `running`.
    await server.app.close();
    server = await startServer(stubHarness(), { dataDir });
    const taskAgain = await server.api('GET', `/api/tasks/${taskId}`);
    expect(taskAgain.body.state).toBe('ready');
    expect(taskAgain.body.state).toBe('escalated');

    sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const escalateFactsAgain = (await sqlite.execute({ sql: "SELECT COUNT(*) as n FROM run_facts WHERE run_id = ? AND type = 'escalate'", args: [runId] })).rows[0] as unknown as {n: number };
    sqlite.close();
    expect(escalateFactsAgain.n).toBe(1);
  });

  it('reconciles (never blindly replays) an in-flight bounded agent re-merge turn interrupted by restart (issue #155, AC4)', async () => {
    server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ stopReason: 'end_turn' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done');
    const dataDir = server.dataDir;
    const runId = started.body.id as number;
    const taskId = created.body.id as number;

    // Simulate the crash: a bounded re-merge corrective turn (issue #155) was in
    // flight against this Run when the process died. `re-merge` `isMutating`, so
    // crash recovery must escalate it — its workspace effect is unknown — rather
    // than dispatching a second mutating turn (a blind replay).
    await server.app.close();
    let sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute({ sql: "UPDATE runs SET state = 'running', phase = 'validating' WHERE id = ?", args: [runId] });
    await sqlite.execute({ sql: "UPDATE tasks SET state = 'running' WHERE id = ?", args: [taskId] });
    await sqlite.execute({
      sql: `INSERT INTO turn_queue (session_id, run_id, seq, status, purpose, expected_workspace_oid, expected_fingerprint, enqueued_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [`run-${runId}`, runId, 1, 'in_flight', 're-merge', 'oid-1', 'fp-1', Date.now(), Date.now()],
    });
    sqlite.close();

    server = await startServer(stubHarness(), { dataDir });

    const run = await server.api('GET', `/api/runs/${runId}`);
    expect(run.body.state).toBe('failed');
    expect(run.body.phase).toBe('terminal');
    const task = await server.api('GET', `/api/tasks/${taskId}`);
    expect(task.body.state).toBe('escalated');
    expect(task.body.escalationReason).toContain('escalated to human');

    sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const escalateFacts = (await sqlite.execute({ sql: "SELECT COUNT(*) as n FROM run_facts WHERE run_id = ? AND type = 'escalate'", args: [runId] })).rows[0] as unknown as {n: number };
    const turn = (await sqlite.execute({ sql: 'SELECT status FROM turn_queue WHERE run_id = ?', args: [runId] })).rows[0] as unknown as {status: string };
    sqlite.close();
    expect(escalateFacts.n).toBe(1);
    expect(turn.status).toBe('failed'); // reconciled, not left in flight or replayed
  });

  it('reconciles a Work Context lease a dead owner left behind at boot: released when provably clean, suspect when dirty (issue #123)', async () => {
    const repo = makeRepo();
    try {
      server = await startServer(stubHarness());
      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ stopReason: 'end_turn' }),
        workingDir: repo,
        isolationMode: 'direct',
      });
      const taskId = created.body.id as number;
      const started = await server.api('POST', `/api/tasks/${taskId}/run`);
      await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done');
      const runId = started.body.id as number;
      const dataDir = server.dataDir;
      const key = workContextKey({ isolationMode: 'direct', workingDir: repo });

      // Simulate the crash: the process died mid-flight — the Run is left
      // `running` in a generic (non-parked, non-landing) phase, and its Work
      // Context lease was never released (a Run that settled cleanly would have
      // released it itself).
      await server.app.close();
      let sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
      await sqlite.execute({ sql: "UPDATE runs SET state = 'running', phase = 'validating' WHERE id = ?", args: [runId] });
      await sqlite.execute({ sql: "UPDATE tasks SET state = 'running' WHERE id = ?", args: [taskId] });
      await sqlite.execute({
        sql: `INSERT INTO work_context_leases (key, phase, owner_run_id, heartbeat, expiry, state, acquired_at)
           VALUES (?, 'running', ?, ?, NULL, 'held', ?)`,
        args: [key, runId, Date.now(), Date.now()],
      });
      sqlite.close();

      server = await startServer(stubHarness(), { dataDir });

      // `repo` is clean and on branch `main` — provably safe to free.
      let check = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
      const row = (await check.execute({ sql: 'SELECT state FROM work_context_leases WHERE key = ?', args: [key] })).rows[0];
      check.close();
      expect(row).toBeUndefined();

      // A second dead-owner lease, this time over a dirty working tree, flips
      // to `suspect` instead of being released.
      writeFileSync(join(repo, 'untracked.txt'), 'agent leftovers');
      const created2 = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ stopReason: 'end_turn' }),
        workingDir: repo,
        isolationMode: 'direct',
      });
      const taskId2 = created2.body.id as number;
      const started2 = await server.api('POST', `/api/tasks/${taskId2}/run`);
      await waitFor(async () => (await server.api('GET', `/api/tasks/${taskId2}`)).body.state === 'done');
      const runId2 = started2.body.id as number;

      await server.app.close();
      sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
      await sqlite.execute({ sql: "UPDATE runs SET state = 'running', phase = 'validating' WHERE id = ?", args: [runId2] });
      await sqlite.execute({ sql: "UPDATE tasks SET state = 'running' WHERE id = ?", args: [taskId2] });
      await sqlite.execute({
        sql: `INSERT INTO work_context_leases (key, phase, owner_run_id, heartbeat, expiry, state, acquired_at)
           VALUES (?, 'running', ?, ?, NULL, 'held', ?)`,
        args: [key, runId2, Date.now(), Date.now()],
      });
      sqlite.close();

      server = await startServer(stubHarness(), { dataDir });

      check = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
      const suspectRow = (await check.execute({ sql: 'SELECT state FROM work_context_leases WHERE key = ?', args: [key] })).rows[0] as unknown as
        | { state: string }
        | undefined;
      check.close();
      expect(suspectRow).toBeTruthy();
      expect(suspectRow?.state).toBe('suspect');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  /**
   * Seed a Run that a restart interrupted mid-execution while it was bound to a
   * durable Session: run a native Task to `awaiting-review` (which persists the
   * Session, issue #141), then rewrite it to a plain executing orphan
   * (`state:'running'`, a non-parked phase) with its Session binding intact, as a
   * crash between the ready→running flip and the review gate would leave it.
   * Returns the dataDir, the interrupted Run id, the Task id, and the harness
   * session id / Session row id the resume must reload against.
   */
  async function seedInterruptedSessionRun(): Promise<{
    dataDir: string;
    runId: number;
    taskId: number;
    harnessSessionId: string;
    sessionRowId: number;
  }> {
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ stopReason: 'end_turn' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done');
    const dataDir = server.dataDir;
    const runId = started.body.id as number;
    const taskId = created.body.id as number;

    await server.app.close();
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const runRow = (await sqlite.execute({ sql: 'SELECT session_id as sid, session_row_id as srid FROM runs WHERE id = ?', args: [runId] })).rows[0] as unknown as {
      sid: string;
      srid: number;
    };
    // Rewrite the parked (phase:'review') Run into a plain executing orphan so
    // the boot orphan-fail sweep fails it `interrupted` — the resume input.
    await sqlite.execute({ sql: "UPDATE runs SET state = 'running', phase = 'validating' WHERE id = ?", args: [runId] });
    await sqlite.execute({ sql: "UPDATE tasks SET state = 'running' WHERE id = ?", args: [taskId] });
    sqlite.close();
    return { dataDir, runId, taskId, harnessSessionId: runRow.sid, sessionRowId: runRow.srid };
  }

  it('resumes an interrupted Session-bound Run as a NEW Run + a crash-recovery turn on the SAME Session (issue #146, AC1/AC2/AC5-compatible)', async () => {
    server = await startServer(stubHarness());
    const { dataDir, runId, taskId, harnessSessionId, sessionRowId } = await seedInterruptedSessionRun();

    server = await startServer(stubHarness(), { dataDir });

    const check = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    // The interrupted Run was failed by the orphan sweep...
    expect(((await check.execute({ sql: 'SELECT state FROM runs WHERE id = ?', args: [runId] })).rows[0] as unknown as {state: string }).state).toBe('failed');
    // ...and resumed as a NEW Run bound to the SAME Session.
    const resumeRun = (
      await check.execute({
        sql: 'SELECT id, session_id as sid, session_row_id as srid, prompt FROM runs WHERE task_id = ? AND id != ?',
        args: [taskId, runId],
      })
    ).rows[0] as unknown as {id: number; sid: string; srid: number; prompt: string };
    expect(resumeRun).toBeTruthy();
    expect(resumeRun.srid).toBe(sessionRowId); // resume-same-Session
    expect(resumeRun.sid).toBe(harnessSessionId);
    expect(resumeRun.prompt).toContain('interrupted by a Harmonic restart');

    // The re-entry goes through the per-Session turn queue (single-flight), never
    // a direct driver call — one queued `crash-recovery` turn on the Session.
    const turn = (
      await check.execute({
        sql: 'SELECT run_id as runId, purpose, status FROM turn_queue WHERE session_id = ?',
        args: [harnessSessionId],
      })
    ).rows[0] as unknown as {runId: number; purpose: string; status: string };
    check.close();
    expect(turn).toMatchObject({ runId: resumeRun.id, purpose: 'crash-recovery', status: 'queued' });
  });

  it('fails forward to a fresh summarized Session when the prior one is incompatible (issue #146, AC5-incompatible)', async () => {
    server = await startServer(stubHarness());
    const { dataDir, runId, taskId, harnessSessionId, sessionRowId } = await seedInterruptedSessionRun();

    // Make the stored Session incompatible: it no longer advertises session/load,
    // so the compatibility matrix forces a fresh (summarized) Session.
    await server.app.close();
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute({ sql: 'UPDATE sessions SET supports_load_session = 0 WHERE id = ?', args: [sessionRowId] });
    sqlite.close();

    server = await startServer(stubHarness(), { dataDir });

    const check = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const resumeRun = (
      await check.execute({
        sql: 'SELECT id, session_row_id as srid, prompt FROM runs WHERE task_id = ? AND id != ?',
        args: [taskId, runId],
      })
    ).rows[0] as unknown as {id: number; srid: number | null; prompt: string };
    expect(resumeRun.srid).toBeNull(); // NOT the dead Session — fresh on dispatch
    expect(resumeRun.prompt).toContain('# Resumed Session (Harmonic summary)');

    // The incompatibility reason is persisted on the dead Session.
    const deadSession = (
      await check.execute({
        sql: 'SELECT resume_incompatibility_reason as reason FROM sessions WHERE id = ?',
        args: [sessionRowId],
      })
    ).rows[0] as unknown as {reason: string };
    expect(deadSession.reason).toBe('load-session-unsupported');

    // No turn was left on the dead Session; the re-entry is on a fresh queue id.
    expect(
      (await check.execute({ sql: 'SELECT COUNT(*) as n FROM turn_queue WHERE session_id = ?', args: [harnessSessionId] })).rows[0],
    ).toMatchObject({
      n: 0,
    });
    const freshTurn = (
      await check.execute({ sql: 'SELECT purpose, status FROM turn_queue WHERE run_id = ?', args: [resumeRun.id] })
    ).rows[0] as unknown as {purpose: string; status: string };
    check.close();
    expect(freshTurn).toMatchObject({ purpose: 'crash-recovery', status: 'queued' });
  });

  it('is idempotent across repeat boots — a second restart resumes nothing new (issue #146, AC3)', async () => {
    server = await startServer(stubHarness());
    const { dataDir, taskId, harnessSessionId } = await seedInterruptedSessionRun();

    server = await startServer(stubHarness(), { dataDir });
    // Snapshot after the first resume.
    let check = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const runsAfterFirst = ((await check.execute({ sql: 'SELECT COUNT(*) as n FROM runs WHERE task_id = ?', args: [taskId] })).rows[0] as unknown as {n: number }).n;
    const turnsAfterFirst = (
      (await check.execute({ sql: 'SELECT COUNT(*) as n FROM turn_queue WHERE purpose = ?', args: ['crash-recovery'] })).rows[0] as unknown as {n: number }
    ).n;
    check.close();
    expect(runsAfterFirst).toBe(2); // the interrupted Run + its one resume Run
    expect(turnsAfterFirst).toBe(1);

    // A second restart: the interrupted Run carries `session-resumed` and its
    // resume Run carries `resume-entry`, so neither is resumed again; the pending
    // crash-recovery turn survives (it is the resume re-entry, not a stale turn).
    await server.app.close();
    server = await startServer(stubHarness(), { dataDir });

    check = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const runsAfterSecond = ((await check.execute({ sql: 'SELECT COUNT(*) as n FROM runs WHERE task_id = ?', args: [taskId] })).rows[0] as unknown as {n: number }).n;
    const turnsAfterSecond = (
      (await check.execute({ sql: 'SELECT COUNT(*) as n FROM turn_queue WHERE purpose = ?', args: ['crash-recovery'] })).rows[0] as unknown as {n: number }
    ).n;
    const survivingTurn = (
      await check.execute({ sql: 'SELECT status FROM turn_queue WHERE session_id = ?', args: [harnessSessionId] })
    ).rows[0] as unknown as {status: string };
    // The resume Run itself is NOT re-orphaned across the second boot: it is a
    // resume re-entry parked awaiting dispatch, so it stays `running` and its
    // Task stays `running` rather than regressing to `failed`.
    const resumeRun = (
      await check.execute({ sql: 'SELECT state FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1', args: [taskId] })
    ).rows[0] as unknown as {state: string };
    const taskState = ((await check.execute({ sql: 'SELECT state FROM tasks WHERE id = ?', args: [taskId] })).rows[0] as unknown as {state: string }).state;
    check.close();
    expect(runsAfterSecond).toBe(runsAfterFirst); // no duplicate resume Run
    expect(turnsAfterSecond).toBe(turnsAfterFirst); // no duplicate turn
    expect(survivingTurn.status).toBe('queued'); // preserved, not cancelled
    expect(resumeRun.state).toBe('running'); // parked awaiting dispatch, not re-orphaned
    expect(taskState).toBe('running');
  });
});
