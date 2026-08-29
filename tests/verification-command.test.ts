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
 * Escalates and never merges. The driven path freezes a candidate OID in
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

  it('AC1/AC3/AC4/AC5: a passing command merges a native Run to done; the attempt records the verified head OID', async () => {
    await server.app.ctx.workspaces.update(workspaceId, { verificationCommand: [exitCommand(0)] });
    const { taskId, runId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run).toMatchObject({ state: 'completed' });
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

  it('a direct Run works in place: its verified commit is the base branch tip, with no private ref and no run branch (ADR-0046)', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'direct',
      verificationCommand: [exitCommand(0)],
    });
    const baseBefore = git(repoDir, 'rev-parse', 'main');
    const { taskId, runId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    // The candidate is the agent's own commit, and it already sits on the live
    // base branch — the branch advanced forward in place, nothing was merged.
    expect(run.candidateOid).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repoDir, 'rev-parse', 'main')).toBe(run.candidateOid);
    expect(run.candidateOid).not.toBe(baseBefore);
    // No private direct ref, and no operator-facing run branch: direct isolation
    // has no candidate ref at all now.
    expect(git(repoDir, 'for-each-ref', 'refs/harmonic/')).toBe('');
    expect(run.branch).toBeNull();
    expect(run.candidateRef).toBeNull();
  });

  it('a pre-existing dirty tree does not fail a direct Run; its candidate is the agent\'s own commit (ADR-0046)', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'direct',
      verificationCommand: [exitCommand(0)],
    });
    // Uncommitted changes the agent did not make, present before the Run starts.
    writeFileSync(join(repoDir, 'operator-scratch.txt'), 'not the agent\n');

    const { taskId, runId } = await createAndRun();
    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done'); // tolerated — never escalated for the dirty tree
    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.candidateOid).toMatch(/^[0-9a-f]{40}$/);

    rmSync(join(repoDir, 'operator-scratch.txt'), { force: true });
  });

  it('AC2/AC4: a failing command records feedback on attempt 1, then escalates after attempt 2', async () => {
    await server.app.ctx.workspaces.update(workspaceId, { verificationCommand: [exitCommand(1)] });
    const { taskId, runId } = await createAndRun();

    // The Run terminates failed rather than parking for review or merging.
    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');
    expect(run.finishedAt).not.toBeNull();

    // The Task never merged; it was handed back to a human.
    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).toBe('escalated');

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
      { number: 2, state: 'escalated' },
    ]);
    expect(timeline.body.attempts[0].feedback).toContain('verifier command failed');
  });

  it('AC2/AC4: an inconclusive command consumes the same bounded Attempt loop', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: [
        verificationCommandSchema.parse({
          command: 'definitely-not-a-real-command-xyzzy',
          args: [],
          timeoutSeconds: 30,
        }),
      ],
    });
    const { taskId, runId } = await createAndRun();

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');

    const rows = await attempts(runId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.verdict === 'inconclusive')).toBe(true);
    const timeline = await server.api('GET', `/api/tasks/${taskId}/attempts`);
    expect(timeline.body.attempts.map((attempt: { number: number; state: string }) => ({ number: attempt.number, state: attempt.state }))).toEqual([
      { number: 1, state: 'failed' },
      { number: 2, state: 'escalated' },
    ]);
  });

  it('a configured command with no committed implementation fails closed', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'direct',
      verificationCommand: [exitCommand(0)],
    });
    writeFileSync(join(repoDir, 'uncommitted.txt'), 'dirty\n');

    const { runId } = await createAndRun({ stopReason: 'end_turn' });
    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');
    expect(run.candidateOid).toBeNull();

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
    // The nudge is corrective guidance inside the Attempt, not a new one: the
    // Run settles on the same single Attempt.
    await waitFor(async () => ((await server.api('GET', `/api/runs/${runId}`)).body.state !== 'running' ? true : undefined));
    const timeline = await server.api('GET', `/api/tasks/${taskId}/attempts`);
    expect(timeline.body.attempts).toHaveLength(1);
    expect(timeline.body.attempts[0]).toMatchObject({ number: 1 });
    // Leave the shared repo clean for the merges that follow (the stub never committed).
    rmSync(join(repoDir, 'nudge-me.txt'), { force: true });
  });

  // Was "a pass records a verified-head fact at the exact SHA, and the gate
  // refuses a moved tip" — the `verified-head` run-fact and the Runner's
  // `mergeFreshness` freshness gate are BOTH deleted by #381 (ADR-0001, the
  // one merge policy): a moved base is normal and is never re-verified, the
  // merge commit reconciles it. The surviving purpose — a command pass
  // actually merges the Run's work onto the base — is now proven by asserting
  // the merge landed as a real merge commit (never a fast-forward).
  it('a pass merges the Run onto the base as an ordinary merge commit (ADR-0001)', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'worktree',
      verificationCommand: [exitCommand(0)],
    });
    const { taskId, runId } = await createAndRun();
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.candidateOid).toBeTruthy();
    // The one merge policy: an ordinary `git merge --no-ff` — main's merge
    // commit has the run's verified branch tip as its second parent, and
    // shows up in `--merges` history (never a fast-forward).
    expect(git(repoDir, 'rev-parse', 'main^2')).toBe(run.candidateOid);
    expect(git(repoDir, 'log', '--merges', 'main')).not.toBe('');
  });

  it('opens every Attempt with a recorded Rebase Task, including a clean no-op rebase', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'worktree',
      verificationCommand: [exitCommand(0)],
    });
    const { taskId } = await createAndRun();
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });

    const timeline = await server.api('GET', `/api/tasks/${taskId}/attempts`);
    expect(timeline.body.attempts[0].steps[0]).toMatchObject({
      type: 'rebase',
      state: 'passed',
      verdict: 'pass',
    });
  });

  it('ordered commands run in sequence and fail fast: a red command blocks the rest', async () => {
    const echoExit = (marker: string, code: number) =>
      verificationCommandSchema.parse({
        command: process.execPath,
        args: ['-e', `console.log('${marker}'); process.exit(${code})`],
        timeoutSeconds: 30,
      });
    await server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'worktree',
      verificationCommand: [echoExit('CMD1', 0), echoExit('CMD2', 1), echoExit('CMD3', 0)],
    });
    const { runId } = await createAndRun();
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });

    // Two attempts (maxAttempts: 2), each running CMD1 then failing fast on
    // CMD2 — one attempt row per executed command, and CMD3 never runs.
    const rows = await attempts(runId);
    expect(rows.map((row) => `${row.mechanism}:${row.verdict}`)).toEqual([
      'command:pass',
      'command:fail',
      'command:pass',
      'command:fail',
    ]);
    expect(rows.map((row) => row.output.trim())).toEqual(['CMD1', 'CMD2', 'CMD1', 'CMD2']);
  });
});

/**
 * Native merging (issue #138,
 * ADR-0021). The single new row: native + a verifier that actually RAN and
 * PASSED + auto-accept ON → merge with no human gate. Every other cell of the
 * table (no verifier, auto-accept off, a fail/inconclusive verdict) still
 * routes to review/Escalate exactly as #135 left it — auto-accept only ever
 * *skips* the human gate on a genuine pass, it never rescues a red verdict
 * and never fires with nothing verified. A dedicated server + repo (rather
 * than the shared one above) keeps each transition's Workspace state isolated.
 */
describe('native merging (issue #138, ADR-0021, ADR-0041)', () => {
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

  it('a passing verification merges directly — there is no review gate to park at (ADR-0041)', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: [exitCommand(0)],
    });
    const { taskId, runId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.state).toBe('completed');
  });

  it('a pass merges under Harmonic\'s own merge fact, never the operator disposition', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: [exitCommand(0)],
    });
    const { taskId, runId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.state).toBe('completed');
    expect(run.finishedAt).not.toBeNull();

    const rows = await attempts(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ mechanism: 'command', verdict: 'pass' });

    // Harmonic merging the Run is not an operator — it appends the default
    // `agent-finish/unresolved` merge fact, never the operator-only
    // `operator-accept` disposition, so the audit log stays honest about who
    // actually accepted the work.
    const factTypes = (await new RunFactStore(server.app.ctx.asyncDb).list(runId)).map((f) => f.type);
    expect(factTypes).toContain('agent-finish/unresolved');
    expect(factTypes).not.toContain('operator-accept');
  });

  it('safety: a fail on every attempt Escalates — merging never rescues a red verdict', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: [exitCommand(1)],
    });
    const { taskId, runId } = await createAndRun();

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'escalated' ? body : undefined;
    });
    expect(task.escalationReason).toMatch(/failed/);
  });

  it('with NO verifier configured a run still merges — nothing to verify means nothing blocks (ADR-0041)', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: null,
    });
    const { taskId, runId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.state).toBe('completed');

    // No verifier ran at all — the attempt log is empty.
    expect(await attempts(runId)).toHaveLength(0);
  });

  it('a worktree run merges the merge into the base branch (no human gate)', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: [exitCommand(0)],
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
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = (await server.api('GET', `/api/runs/${started.body.id}`)).body;
    expect(run.state).toBe('completed');

    // The merge actually happened: the base branch moved and now contains the
    // Run's commit, without any human ever calling Accept.
    const baseOidAfter = git(repoDir, 'rev-parse', 'main');
    expect(baseOidAfter).not.toBe(baseOidBefore);
    const mergedFiles = git(repoDir, 'show', `${baseOidAfter}:auto-accept-feature.txt`);
    expect(mergedFiles).toBe('made by agent');
  });
});
