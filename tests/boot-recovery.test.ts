import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

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
    const sqlite = new Database(join(dataDir, 'harmonic.db'));
    sqlite.prepare('UPDATE tasks SET state = ? WHERE id = ?').run('running', id);
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
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review');
    const dataDir = server.dataDir;

    await server.app.close();
    server = await startServer(stubHarness(), { dataDir });

    const task = await server.api('GET', `/api/tasks/${created.body.id}`);
    expect(task.body.state).toBe('awaiting-review'); // survived, not failed
    const run = await server.api('GET', `/api/runs/${started.body.id}`);
    expect(run.body.state).toBe('running');
    expect(run.body.phase).toBe('review');
  });

  it('sweeps a review-parked Run past its SLA to a terminal disposition at boot, via a run_fact (issue #114)', async () => {
    server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ stopReason: 'end_turn' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review');
    const dataDir = server.dataDir;
    const runId = started.body.id as number;

    // Force the review SLA into the past (an abandoned review), then reboot.
    await server.app.close();
    const sqlite = new Database(join(dataDir, 'harmonic.db'));
    sqlite.prepare('UPDATE runs SET review_deadline = ? WHERE id = ?').run(1, runId);
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
    const check = new Database(join(dataDir, 'harmonic.db'), { readonly: true });
    const fact = check
      .prepare('SELECT type FROM run_facts WHERE run_id = ? AND type = ?')
      .get(runId, 'review-sla-expiry');
    check.close();
    expect(fact).toBeTruthy();
  });

  it('reconciles a Run crashed mid-landing whose effect already applied — completes it without re-merging or duplicating the journal (issue #117, AC1/AC5)', async () => {
    server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ stopReason: 'end_turn' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review');
    const dataDir = server.dataDir;
    const runId = started.body.id as number;
    const taskId = created.body.id as number;

    // Simulate the crash: the process died right after the merge landed and
    // its result was journaled, but before the finishing settle ran.
    await server.app.close();
    const branch = 'run-branch';
    const baseBranch = 'main';
    const idempotencyKey = `${baseBranch}<-${branch}`;
    const sqlite = new Database(join(dataDir, 'harmonic.db'));
    sqlite.prepare("UPDATE runs SET phase = 'landing', branch = ?, base_branch = ? WHERE id = ?").run(branch, baseBranch, runId);
    // Same fact type `LandingCoordinator.land()` writes at its step 2, before
    // the PONC (landing-coordinator.ts's `LAND_FACT_TYPE`).
    sqlite
      .prepare('INSERT INTO run_facts (run_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)')
      .run(runId, 1, Date.now(), 'agent-finish/unresolved', JSON.stringify({ runState: 'completed', taskAction: 'completed', reason: null }));
    sqlite
      .prepare('INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, 1, Date.now(), 'ponc', null, null, JSON.stringify({ cutoffSeq: 1 }));
    sqlite
      .prepare('INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, 2, Date.now(), 'intent', 'target-ref', idempotencyKey, JSON.stringify({ expected: { baseBranch, branch } }));
    sqlite
      .prepare('INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, 3, Date.now(), 'result', 'target-ref', idempotencyKey, JSON.stringify({ ok: true, observed: { baseBranch, branch } }));
    sqlite.close();

    server = await startServer(stubHarness(), { dataDir });

    // The boot sweep completed the landing exactly as `land()` itself would
    // have, without touching git (the journal already showed it applied).
    const run = await server.api('GET', `/api/runs/${runId}`);
    expect(run.body.state).toBe('completed');
    expect(run.body.phase).toBe('terminal');
    expect(run.body.review).toBe('accepted');
    const task = await server.api('GET', `/api/tasks/${taskId}`);
    expect(task.body.state).toBe('completed');

    // No duplicate/re-applied result for the already-applied effect.
    const check = new Database(join(dataDir, 'harmonic.db'), { readonly: true });
    const results = check
      .prepare("SELECT COUNT(*) as n FROM landing_journal WHERE run_id = ? AND kind = 'result' AND idempotency_key = ?")
      .get(runId, idempotencyKey) as { n: number };
    check.close();
    expect(results.n).toBe(1);
  });

  it('is idempotent across repeated boots once a mid-landing reconcile completes (issue #117, AC4)', async () => {
    server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ stopReason: 'end_turn' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review');
    const dataDir = server.dataDir;
    const runId = started.body.id as number;

    await server.app.close();
    const branch = 'run-branch';
    const baseBranch = 'main';
    const idempotencyKey = `${baseBranch}<-${branch}`;
    let sqlite = new Database(join(dataDir, 'harmonic.db'));
    sqlite.prepare("UPDATE runs SET phase = 'landing', branch = ?, base_branch = ? WHERE id = ?").run(branch, baseBranch, runId);
    sqlite
      .prepare('INSERT INTO run_facts (run_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)')
      .run(runId, 1, Date.now(), 'agent-finish/unresolved', JSON.stringify({ runState: 'completed', taskAction: 'completed', reason: null }));
    sqlite
      .prepare('INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, 1, Date.now(), 'ponc', null, null, JSON.stringify({ cutoffSeq: 1 }));
    sqlite
      .prepare('INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, 2, Date.now(), 'intent', 'target-ref', idempotencyKey, JSON.stringify({ expected: { baseBranch, branch } }));
    sqlite
      .prepare('INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, 3, Date.now(), 'result', 'target-ref', idempotencyKey, JSON.stringify({ ok: true, observed: { baseBranch, branch } }));
    sqlite.close();

    server = await startServer(stubHarness(), { dataDir });
    expect((await server.api('GET', `/api/runs/${runId}`)).body.state).toBe('completed');

    await server.app.close();
    sqlite = new Database(join(dataDir, 'harmonic.db'), { readonly: true });
    const factCount = (sqlite.prepare('SELECT COUNT(*) as n FROM run_facts WHERE run_id = ?').get(runId) as { n: number }).n;
    const journalCount = (sqlite.prepare('SELECT COUNT(*) as n FROM landing_journal WHERE run_id = ?').get(runId) as { n: number }).n;
    sqlite.close();

    // A second boot: the Run already left `state:'running'`, so `listLandingOrphans`
    // no longer selects it — nothing for this sweep to do.
    server = await startServer(stubHarness(), { dataDir });
    expect((await server.api('GET', `/api/runs/${runId}`)).body.state).toBe('completed');

    sqlite = new Database(join(dataDir, 'harmonic.db'), { readonly: true });
    const factCount2 = (sqlite.prepare('SELECT COUNT(*) as n FROM run_facts WHERE run_id = ?').get(runId) as { n: number }).n;
    const journalCount2 = (sqlite.prepare('SELECT COUNT(*) as n FROM landing_journal WHERE run_id = ?').get(runId) as { n: number }).n;
    sqlite.close();
    expect(factCount2).toBe(factCount);
    expect(journalCount2).toBe(journalCount);
  });

  it('reconciles all three stores together in one boot sweep — facts, journal, and queue for the same mid-landing Run (issue #117, AC1)', async () => {
    server = await startServer(stubHarness());
    const created = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ stopReason: 'end_turn' }) });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review');
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
    const sqlite = new Database(join(dataDir, 'harmonic.db'));
    sqlite.prepare("UPDATE runs SET phase = 'landing', branch = ?, base_branch = ? WHERE id = ?").run(branch, baseBranch, runId);
    sqlite
      .prepare('INSERT INTO run_facts (run_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)')
      .run(runId, 1, Date.now(), 'agent-finish/unresolved', JSON.stringify({ runState: 'completed', taskAction: 'completed', reason: null }));
    sqlite
      .prepare('INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, 1, Date.now(), 'ponc', null, null, JSON.stringify({ cutoffSeq: 1 }));
    sqlite
      .prepare('INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, 2, Date.now(), 'intent', 'target-ref', idempotencyKey, JSON.stringify({ expected: { baseBranch, branch } }));
    sqlite
      .prepare('INSERT INTO landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, 3, Date.now(), 'result', 'target-ref', idempotencyKey, JSON.stringify({ ok: true, observed: { baseBranch, branch } }));
    sqlite
      .prepare(
        `INSERT INTO turn_queue (session_id, run_id, seq, status, purpose, enqueued_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('sess-ac1', runId, 1, 'queued', 'continue', Date.now());
    sqlite.close();

    server = await startServer(stubHarness(), { dataDir });

    // Consistent, non-duplicating outcome: pass A completes the landing
    // exactly once, and pass B (same boot) sweeps the stale queued turn.
    const run = await server.api('GET', `/api/runs/${runId}`);
    expect(run.body.state).toBe('completed');
    expect(run.body.phase).toBe('terminal');
    const task = await server.api('GET', `/api/tasks/${taskId}`);
    expect(task.body.state).toBe('completed');

    const check = new Database(join(dataDir, 'harmonic.db'), { readonly: true });
    const results = check
      .prepare("SELECT COUNT(*) as n FROM landing_journal WHERE run_id = ? AND kind = 'result' AND idempotency_key = ?")
      .get(runId, idempotencyKey) as { n: number };
    const turn = check.prepare('SELECT status, cancel_reason as cancelReason FROM turn_queue WHERE run_id = ?').get(runId) as {
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
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review');
    const dataDir = server.dataDir;
    const runId = started.body.id as number;
    const taskId = created.body.id as number;

    // Simulate the crash: a self-heal turn was in flight against this Run,
    // whose effect on the workspace is now unknown.
    await server.app.close();
    let sqlite = new Database(join(dataDir, 'harmonic.db'));
    sqlite.prepare("UPDATE runs SET state = 'running', phase = 'validating' WHERE id = ?").run(runId);
    sqlite.prepare("UPDATE tasks SET state = 'running' WHERE id = ?").run(taskId);
    sqlite
      .prepare(
        `INSERT INTO turn_queue (session_id, run_id, seq, status, purpose, expected_workspace_oid, expected_fingerprint, enqueued_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('sess-1', runId, 1, 'in_flight', 'self-heal', 'oid-1', 'fp-1', Date.now(), Date.now());
    sqlite.close();

    server = await startServer(stubHarness(), { dataDir });

    const run = await server.api('GET', `/api/runs/${runId}`);
    expect(run.body.state).toBe('failed');
    expect(run.body.phase).toBe('terminal');
    const task = await server.api('GET', `/api/tasks/${taskId}`);
    expect(task.body.state).toBe('ready');
    expect(task.body.escalated).toBe(true);
    expect(task.body.drive).toBe('hitl');

    sqlite = new Database(join(dataDir, 'harmonic.db'), { readonly: true });
    const escalateFacts = sqlite.prepare("SELECT COUNT(*) as n FROM run_facts WHERE run_id = ? AND type = 'escalate'").get(runId) as { n: number };
    const turn = sqlite.prepare('SELECT status FROM turn_queue WHERE run_id = ?').get(runId) as { status: string };
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
    expect(taskAgain.body.escalated).toBe(true);

    sqlite = new Database(join(dataDir, 'harmonic.db'), { readonly: true });
    const escalateFactsAgain = sqlite.prepare("SELECT COUNT(*) as n FROM run_facts WHERE run_id = ? AND type = 'escalate'").get(runId) as { n: number };
    sqlite.close();
    expect(escalateFactsAgain.n).toBe(1);
  });
});
