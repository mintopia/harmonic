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
});
