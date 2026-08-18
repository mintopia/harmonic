import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { verificationCommandSchema, verificationCriticSchema, type VerificationCommand } from '../src/config.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import type { CriticHarnessDrive } from '../src/verification/critic.js';
import type { Verdict } from '../src/verification/critic-schema.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed file. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-critic-e2e-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** A critic verifier config; the fake drive supplies the verdict, so the model
 * is just a placeholder the schema accepts. */
const critic = () =>
  verificationCriticSchema.parse({ prompt: 'Review the diff for correctness.', model: 'stub-model' });

/** A `VerificationCommand` running an inline node script with the given exit code. */
const exitCommand = (code: number): VerificationCommand =>
  verificationCommandSchema.parse({
    command: process.execPath,
    args: ['-e', `process.exit(${code})`],
    timeoutSeconds: 30,
  });

/**
 * End-to-end agent critic at the Runner drive-loop seam (issue #164): a native
 * Run over the stub harness against a real git Workspace, with a critic
 * configured. The wired `runVerification` invokes `runCritic` at the frozen
 * candidate OID, feeds its verdict into `combineVerdicts`, and a fail /
 * inconclusive critic blocks/escalates the Run so broken work never lands.
 *
 * The critic's ACP turn is faked via the injectable `criticDrive` seam (the
 * same seam `tests/critic.test.ts` uses at the unit level) so a verdict can be
 * scripted without spawning a real reviewer harness; everything else — the
 * builder turn, the candidate snapshot, the disposable read-only worktree
 * checkout, the settle/land path — is the real Runner.
 */
describe('agent critic end-to-end (issue #164)', () => {
  let server: TestServer;
  let repoDir: string;
  let workspaceId: number;
  /** Mutable per-test verdict the injected fake critic drive returns. */
  let criticResult: { verdict: Verdict; summary: string };

  const criticDrive: CriticHarnessDrive = {
    run: async () => ({ output: JSON.stringify(criticResult), permissionRequests: [] }),
  };

  beforeAll(async () => {
    repoDir = makeRepo();
    server = await startServer(stubHarness(), { criticDrive });
    // Point the default Workspace at a real git repo so `validating` freezes a
    // candidate for the critic to review (the helper's default workdir is a
    // non-git temp dir).
    const ws = server.app.ctx.workspaces.list()[0]!;
    workspaceId = ws.id;
    server.app.ctx.workspaces.update(workspaceId, { workingDir: repoDir });
    // Exercise the verify GATE in isolation: a fail Escalates directly rather
    // than heal→re-verify→escalate (two attempts). Self-heal has its own file.
    server.app.ctx.configStore.update({ verification: { maxSelfHeals: 0 } });
  });
  afterAll(async () => {
    await server.close();
    rmSync(repoDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    criticResult = { verdict: 'pass', summary: 'the change matches the ticket' };
    server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'worktree',
      verificationCommand: null,
      verificationCritic: null,
      verificationAutoAccept: null,
    });
  });

  async function createAndRun(): Promise<{ taskId: number; runId: number }> {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'critic-feature.txt': 'work\n' } }),
      workingDir: repoDir,
      isolationMode: 'worktree',
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    return { taskId: created.body.id, runId: started.body.id };
  }

  const attempts = (runId: number) => new VerificationAttemptStore(server.app.ctx.db).list(runId);
  const verdictEvents = async (runId: number) =>
    (await server.api('GET', `/api/runs/${runId}/events`)).body.events
      .filter((e: any) => e.type === 'lifecycle' && e.payload.event === 'verification')
      .map((e: any) => e.payload);

  it('AC1/AC2: a passing critic lets a native Run park for review; the attempt persists at the frozen candidate OID', async () => {
    criticResult = { verdict: 'pass', summary: 'looks correct' };
    server.app.ctx.workspaces.update(workspaceId, { verificationCritic: critic() });
    const { taskId, runId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'awaiting-review' ? body : undefined;
    });
    expect(task.state).toBe('awaiting-review');

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.phase).toBe('review');
    expect(run.candidateOid).toBeTruthy();

    // AC2: a critic attempt persisted during a real Run, at exactly the frozen OID.
    const rows = attempts(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ mechanism: 'critic', verdict: 'pass', summary: 'looks correct' });
    expect(rows[0]!.inputOid).toBe(run.candidateOid);

    expect(await verdictEvents(runId)).toEqual([
      { event: 'verification', mechanism: 'critic', verdict: 'pass', summary: 'looks correct' },
    ]);
  });

  it('AC3: a failing critic blocks and Escalates the Run — broken work never lands', async () => {
    criticResult = { verdict: 'fail', summary: 'the change breaks the contract' };
    server.app.ctx.workspaces.update(workspaceId, { verificationCritic: critic() });
    const baseOidBefore = git(repoDir, 'rev-parse', 'main');
    const { taskId, runId } = await createAndRun();

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');
    expect(run.phase).not.toBe('review');
    expect(run.phase).not.toBe('landing');
    expect(run.finishedAt).not.toBeNull();

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).not.toBe('awaiting-review');
    expect(task.escalated).toBe(true);

    const rows = attempts(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ mechanism: 'critic', verdict: 'fail', inputOid: run.candidateOid });

    // The base branch never moved — nothing landed.
    expect(git(repoDir, 'rev-parse', 'main')).toBe(baseOidBefore);
  });

  it('AC3: an inconclusive critic Escalates the Run (infra doubt fails safe)', async () => {
    criticResult = { verdict: 'inconclusive', summary: 'cannot tell from the diff alone' };
    server.app.ctx.workspaces.update(workspaceId, { verificationCritic: critic() });
    const { taskId, runId } = await createAndRun();

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');
    expect(run.phase).not.toBe('review');
    expect(run.phase).not.toBe('landing');

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).not.toBe('awaiting-review');

    const rows = attempts(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ mechanism: 'critic', verdict: 'inconclusive' });
  });

  it('AC1: the critic verdict combines with the command verdict — command pass + critic fail still Escalates', async () => {
    criticResult = { verdict: 'fail', summary: 'logic is wrong despite green tests' };
    server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: exitCommand(0),
      verificationCritic: critic(),
    });
    const { taskId, runId } = await createAndRun();

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');
    expect(run.phase).not.toBe('review');
    expect(run.phase).not.toBe('landing');

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).not.toBe('awaiting-review');
    expect(task.escalated).toBe(true);

    // Both verifiers ran and persisted: the command passed, the critic failed —
    // the fail is what combineVerdicts blocked on.
    const rows = attempts(runId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => `${r.mechanism}:${r.verdict}`).sort()).toEqual(['command:pass', 'critic:fail']);
  });

  it('AC1: command pass + critic pass together lets the Run park for review (all verifiers passed)', async () => {
    criticResult = { verdict: 'pass', summary: 'correct and complete' };
    server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: exitCommand(0),
      verificationCritic: critic(),
    });
    const { taskId, runId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'awaiting-review' ? body : undefined;
    });
    expect(task.state).toBe('awaiting-review');

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.phase).toBe('review');

    const rows = attempts(runId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => `${r.mechanism}:${r.verdict}`).sort()).toEqual(['command:pass', 'critic:pass']);
  });

  it('a configured critic with no candidate snapshot (dirty direct context) → inconclusive → Escalate', async () => {
    // Direct mode + a dirty tree skips the candidate snapshot, so there is
    // nothing frozen for the critic to review — infra doubt the gate Escalates
    // on, without ever spawning the critic drive.
    server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'direct',
      verificationCritic: critic(),
    });
    writeFileSync(join(repoDir, 'uncommitted-critic.txt'), 'dirty\n');

    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ stopReason: 'end_turn' }),
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    const runId = started.body.id;

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');
    expect(run.phase).not.toBe('review');
    expect(run.candidateOid).toBeNull();

    const rows = attempts(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ mechanism: 'critic', verdict: 'inconclusive', inputOid: '' });

    rmSync(join(repoDir, 'uncommitted-critic.txt'), { force: true });
  });
});
