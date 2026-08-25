import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { verificationCommandSchema, type VerificationCommand } from '../src/config.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import { RunFactStore } from '../src/domain/run-facts.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed file. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-cmdverify-e2e-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** A `VerificationCommand` running an inline node script with the given exit code. */
const exitCommand = (code: number): VerificationCommand =>
  verificationCommandSchema.parse({
    command: process.execPath,
    args: ['-e', `process.exit(${code})`],
    timeoutSeconds: 30,
  });

/**
 * End-to-end verification gate at the Runner drive-loop seam (issue #135 AC5):
 * a native Run over the stub harness against a real git Workspace, with a
 * command verifier configured. A pass lets the Run park for review; a fail
 * Escalates and never lands. The driven path freezes a candidate OID in
 * `validating` and the persisted attempt records exactly that OID.
 */
describe('command verifier end-to-end (issue #135)', () => {
  let server: TestServer;
  let repoDir: string;
  let workspaceId: number;

  beforeAll(async () => {
    repoDir = makeRepo();
    server = await startServer(stubHarness());
    // Point the default Workspace at a real git repo so `validating` freezes a
    // candidate to verify (the helper's default workdir is a non-git temp dir).
    const ws = (await server.app.ctx.workspaces.list())[0]!;
    workspaceId = ws.id;
    await server.app.ctx.workspaces.update(workspaceId, { workingDir: repoDir });
    // A failed verifier is now a failed Attempt, followed by one corrective
    // Attempt on the same ticket. Keep this suite's bound explicit so the
    // escalation cases exercise the complete two-attempt loop.
    await server.app.ctx.configStore.update({ maxAttempts: 2 });
  });
  afterAll(async () => {
    await server.close();
    rmSync(repoDir, { recursive: true, force: true });
  });

  // Verification is pinned to a committed branch head, so the stub agent must
  // leave a real commit behind (a unique file per run keeps heads distinct).
  let implSeq = 0;
  async function createAndRun(
    scenario: Record<string, unknown> = { writeFiles: { [`impl-${++implSeq}.txt`]: 'implementation\n' } },
  ): Promise<{ taskId: number; runId: number }> {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify(scenario),
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    return { taskId: created.body.id, runId: started.body.id };
  }

  const attempts = (runId: number) => new VerificationAttemptStore(server.app.ctx.asyncDb).list(runId);
  const verdictEvents = async (runId: number) =>
    (await server.api('GET', `/api/runs/${runId}/events`)).body.events
      .filter((e: any) => e.type === 'lifecycle' && e.payload.event === 'verification')
      .map((e: any) => e.payload);

  it('AC1/AC3/AC4/AC5: a passing command lets a native Run park for review, attempt records the frozen candidate OID', async () => {
    await server.app.ctx.workspaces.update(workspaceId, { verificationCommand: exitCommand(0) });
    const { taskId, runId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'awaiting-review' ? body : undefined;
    });
    expect(task.state).toBe('awaiting-review');

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.phase).toBe('review');
    expect(run.candidateOid).toMatch(/^[0-9a-f]{40}$/);

    // AC3/AC5: the attempt is persisted at the branch head the command saw.
    const rows = await attempts(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ mechanism: 'command', verdict: 'pass' });
    expect(rows[0]!.inputOid).toMatch(/^[0-9a-f]{40}$/);

    expect(await verdictEvents(runId)).toEqual([
      { event: 'verification', mechanism: 'command', verdict: 'pass', summary: 'command exited 0' },
    ]);
  });

  it('AC2/AC4: a failing command records feedback on attempt 1, then escalates after attempt 2', async () => {
    await server.app.ctx.workspaces.update(workspaceId, { verificationCommand: exitCommand(1) });
    const { taskId, runId } = await createAndRun();

    // The Run terminates failed rather than parking for review or landing.
    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');
    expect(run.phase).not.toBe('review');
    expect(run.phase).not.toBe('landing');
    expect(run.finishedAt).not.toBeNull();

    // The Task did not reach awaiting-review; it was handed back to a human.
    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).not.toBe('awaiting-review');
    expect(task.escalated).toBe(true);

    const rows = await attempts(runId);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mechanism: 'command', verdict: 'fail' }),
        expect.objectContaining({ mechanism: 'command', verdict: 'fail', inputOid: run.candidateOid }),
      ]),
    );
    const timeline = await server.api('GET', `/api/tasks/${taskId}/attempts`);
    expect(timeline.body.attempts.map((attempt: { number: number; state: string }) => ({ number: attempt.number, state: attempt.state }))).toEqual([
      { number: 1, state: 'failed' },
      { number: 2, state: 'failed' },
    ]);
    expect(timeline.body.attempts[0].feedback).toContain('verifier command failed');
  });

  it('AC2/AC4: an inconclusive command consumes the same bounded Attempt loop', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: verificationCommandSchema.parse({
        command: 'definitely-not-a-real-command-xyzzy',
        args: [],
        timeoutSeconds: 30,
      }),
    });
    const { taskId, runId } = await createAndRun();

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');
    expect(run.phase).not.toBe('review');

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).not.toBe('awaiting-review');

    const rows = await attempts(runId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.verdict === 'inconclusive')).toBe(true);
    const timeline = await server.api('GET', `/api/tasks/${taskId}/attempts`);
    expect(timeline.body.attempts.map((attempt: { number: number; state: string }) => ({ number: attempt.number, state: attempt.state }))).toEqual([
      { number: 1, state: 'failed' },
      { number: 2, state: 'failed' },
    ]);
  });

  it('a configured command with no committed implementation fails closed', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'direct',
      verificationCommand: exitCommand(0),
    });
    writeFileSync(join(repoDir, 'uncommitted.txt'), 'dirty\n');

    const { taskId, runId } = await createAndRun({ stopReason: 'end_turn' });
    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');
    expect(run.phase).not.toBe('review');
    expect(run.candidateOid).toBeNull();

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).not.toBe('awaiting-review');

    const rows = await attempts(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ mechanism: 'command', verdict: 'inconclusive', inputOid: '' });
    // Leave the shared repo clean: a leftover dirty file would mark the next
    // direct Run startDirty and suppress its commit nudge.
    rmSync(join(repoDir, 'uncommitted.txt'), { force: true });
  });

  it('a dirty worktree receives one commit nudge without consuming an Attempt', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'direct',
      verificationCommand: null,
    });
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'nudge-me.txt': 'dirty\n' }, commit: false }),
      workingDir: repoDir,
      isolationMode: 'direct',
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    const { id: taskId } = created.body as { id: number };
    const { id: runId } = started.body as { id: number };
    await waitFor(async () => {
      const events = (await server.api('GET', `/api/runs/${runId}/events`)).body.events;
      return events.some((event: { payload: { event?: string } }) => event.payload.event === 'commit-nudge') ? true : undefined;
    });
    const timeline = await server.api('GET', `/api/tasks/${taskId}/attempts`);
    expect(timeline.body.attempts).toHaveLength(1);
    expect(timeline.body.attempts[0]).toMatchObject({ number: 1, state: 'running' });
  });
});

/**
 * Native review-before-land transition table + auto-accept (issue #138,
 * ADR-0021). The single new row: native + a verifier that actually RAN and
 * PASSED + auto-accept ON → land with no human gate. Every other cell of the
 * table (no verifier, auto-accept off, a fail/inconclusive verdict) still
 * routes to review/Escalate exactly as #135 left it — auto-accept only ever
 * *skips* the human gate on a genuine pass, it never rescues a red verdict
 * and never fires with nothing verified. A dedicated server + repo (rather
 * than the shared one above) keeps each transition's Workspace state isolated.
 */
describe('native auto-accept (issue #138, ADR-0021)', () => {
  let server: TestServer;
  let repoDir: string;
  let workspaceId: number;

  beforeAll(async () => {
    repoDir = makeRepo();
    server = await startServer(stubHarness());
    const ws = (await server.app.ctx.workspaces.list())[0]!;
    workspaceId = ws.id;
    await server.app.ctx.workspaces.update(workspaceId, { workingDir: repoDir });
  });
  afterAll(async () => {
    await server.close();
    rmSync(repoDir, { recursive: true, force: true });
  });

  let implSeq = 0;
  async function createAndRun(): Promise<{ taskId: number; runId: number }> {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { [`auto-accept-impl-${++implSeq}.txt`]: 'implementation\n' } }),
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    return { taskId: created.body.id, runId: started.body.id };
  }

  const attempts = (runId: number) => new VerificationAttemptStore(server.app.ctx.asyncDb).list(runId);

  it('row 2 (regression): auto-accept OFF + a pass still parks for review', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: exitCommand(0),
      verificationAutoAccept: false,
    });
    const { taskId, runId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'awaiting-review' ? body : undefined;
    });
    expect(task.state).toBe('awaiting-review');

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.phase).toBe('review');
  });

  it('row 3 (NEW): auto-accept ON + a pass lands directly, never parking for review', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: exitCommand(0),
      verificationAutoAccept: true,
    });
    const { taskId, runId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'completed' ? body : undefined;
    });
    expect(task.state).toBe('completed');
    expect(task.state).not.toBe('awaiting-review');

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.state).toBe('completed');
    expect(run.phase).toBe('terminal');
    expect(run.finishedAt).not.toBeNull();

    const rows = await attempts(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ mechanism: 'command', verdict: 'pass' });

    // Auto-accept is Harmonic landing the Run, not an operator — it must
    // keep appending the default `agent-finish/unresolved` land fact (issue
    // #191), never the operator-only `operator-accept` disposition, so the
    // audit log stays honest about who actually accepted the work.
    const factTypes = (await new RunFactStore(server.app.ctx.asyncDb).list(runId)).map((f) => f.type);
    expect(factTypes).toContain('agent-finish/unresolved');
    expect(factTypes).not.toContain('operator-accept');
  });

  it('safety: auto-accept ON + a fail still Escalates — auto-accept never rescues a red verdict', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: exitCommand(1),
      verificationAutoAccept: true,
    });
    const { taskId, runId } = await createAndRun();

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');
    expect(run.phase).not.toBe('landing');
    expect(run.phase).not.toBe('review');

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).not.toBe('completed');
    expect(task.state).not.toBe('awaiting-review');
    expect(task.escalated).toBe(true);
  });

  it('row 1: auto-accept ON but NO verifier configured still parks for review (nothing to auto-accept)', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: null,
      verificationAutoAccept: true,
    });
    const { taskId, runId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'awaiting-review' ? body : undefined;
    });
    expect(task.state).toBe('awaiting-review');

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.phase).toBe('review');
    expect(run.state).toBe('running'); // parked, not settled

    // No verifier ran at all — the attempt log is empty.
    expect(await attempts(runId)).toHaveLength(0);
  });

  it('a worktree auto-accept lands the merge into the base branch (no human gate)', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: exitCommand(0),
      verificationAutoAccept: true,
    });
    const baseOidBefore = git(repoDir, 'rev-parse', 'main');

    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'auto-accept-feature.txt': 'made by agent\n' } }),
      workingDir: repoDir,
      isolationMode: 'worktree',
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${created.body.id}`);
      return body.state === 'completed' ? body : undefined;
    });
    expect(task.state).toBe('completed');

    const run = (await server.api('GET', `/api/runs/${started.body.id}`)).body;
    expect(run.state).toBe('completed');
    expect(run.phase).toBe('terminal');

    // The merge actually happened: the base branch moved and now contains the
    // Run's commit, without any human ever calling Accept.
    const baseOidAfter = git(repoDir, 'rev-parse', 'main');
    expect(baseOidAfter).not.toBe(baseOidBefore);
    const mergedFiles = git(repoDir, 'show', `${baseOidAfter}:auto-accept-feature.txt`);
    expect(mergedFiles).toBe('made by agent');
  });
});
