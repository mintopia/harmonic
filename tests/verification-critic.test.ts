import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { verificationCommandSchema, type VerificationCommand, type HarnessId } from '../src/config.js';
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

/** The decomposed review-override fields (issue #337) for a configured critic;
 * the fake drive supplies the verdict, so the model is just a placeholder. */
const critic = () => ({ reviewEnabled: true, reviewPrompt: 'Review the diff for correctness.', reviewModel: 'stub-model' });

/** Same, pinned to a specific reviewer harness (issue #174 FIX 2) rather than
 * "Same as task". */
const criticWithHarness = (harness: HarnessId) => ({ ...critic(), reviewHarness: harness });

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
 * inconclusive critic blocks/escalates the Run so broken work never merges.
 *
 * The critic's ACP turn is faked via the injectable `criticDrive` seam (the
 * same seam `tests/critic.test.ts` uses at the unit level) so a verdict can be
 * scripted without spawning a real reviewer harness; everything else — the
 * builder turn, the candidate snapshot, the disposable read-only worktree
 * checkout, the settle/merge path — is the real Runner.
 */
describe('agent critic end-to-end (issue #164)', () => {
  let server: TestServer;
  let repoDir: string;
  let workspaceId: number;
  /** Mutable per-test verdict the injected fake critic drive returns. */
  let criticResult: { verdict: Verdict; summary: string };
  /** The `harnessId` the most recent critic drive call was invoked with (issue
   * #174) — lets a test assert `runCritic` was resolved against the critic's
   * own configured harness rather than always the builder task's. */
  let lastCriticHarnessId: string | undefined;

  const criticDrive: CriticHarnessDrive = {
    run: async (req) => {
      lastCriticHarnessId = req.harnessId;
      return { output: JSON.stringify(criticResult), permissionRequests: [] };
    },
  };

  beforeAll(async () => {
    repoDir = makeRepo();
    server = await startServer(stubHarness(), { criticDrive });
    // Point the default Workspace at a real git repo so `validating` freezes a
    // candidate for the critic to review (the helper's default workdir is a
    // non-git temp dir).
    const ws = (await server.app.ctx.workspaces.list())[0]!;
    workspaceId = ws.id;
    await server.app.ctx.workspaces.update(workspaceId, { workingDir: repoDir });
    // Keep Session and Run ids intentionally out of step so the Attempt
    // timeline proves its implementation locator uses the durable Session row,
    // not the legacy Run id (issue #309).
    await server.app.ctx.sessions.recordDispatch({
      harness: 'claude',
      harnessSessionId: 'issue-309-locator-offset',
      model: 'stub-model',
      cwd: repoDir,
      workspaceId,
      mcpTemplates: [],
      capabilities: undefined,
      adapterVersion: 'stub@1',
      now: Date.now(),
    });
    // A failed verifier now creates a corrective Attempt on the same ticket.
    // Keep the cap fixed so escalation scenarios cover both attempts.
    await server.app.ctx.configStore.update({ maxAttempts: 2 });
  });
  afterAll(async () => {
    await server.close();
    rmSync(repoDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    criticResult = { verdict: 'pass', summary: 'the change matches the ticket' };
    lastCriticHarnessId = undefined;
    await server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'worktree',
      verificationCommand: null,
      reviewEnabled: null,
      reviewPrompt: null,
      reviewModel: null,
      reviewHarness: null,
    });
  });

  // A merged run merges its file into main, so a repeated identical write would
  // leave the next stub agent nothing to commit. A unique file per run keeps
  // every run's commit real.
  let implSeq = 0;
  async function createAndRun(): Promise<{ taskId: number; runId: number }> {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { [`critic-feature-${++implSeq}.txt`]: 'work\n' } }),
      workingDir: repoDir,
      isolationMode: 'worktree',
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    return { taskId: created.body.id, runId: started.body.id };
  }

  // `verification_attempts` is keyed off `attempt_id`, not `run_id`
  // (ADR-0001 #388 S-F): a self-heal loop's failed attempts share one Run row
  // but each get their own Attempt row, so "this Run's verification
  // attempts" now folds the log across every Attempt of the Run's Task.
  const attempts = async (taskId: number) => {
    const store = new VerificationAttemptStore(server.app.ctx.asyncDb);
    const taskAttempts = await server.app.ctx.attempts.listForTask(taskId);
    return (await Promise.all(taskAttempts.map((a) => store.list(a.id)))).flat();
  };
  const verdictEvents = async (runId: number) =>
    (await server.api('GET', `/api/attempts/${runId}/events`)).body.events
      .filter((e: any) => e.type === 'lifecycle' && e.payload.event === 'verification')
      .map((e: any) => e.payload);

  it('AC1/AC2: a passing critic merges a native Run to done; the attempt persists at the verified head OID', async () => {
    criticResult = { verdict: 'pass', summary: 'looks correct' };
    await server.app.ctx.workspaces.update(workspaceId, critic());
    const { taskId, runId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run).toMatchObject({ state: 'completed' });
    expect(run.verifiedHeadOid).toMatch(/^[0-9a-f]{40}$/);

    // AC2: a critic attempt persisted during a real Run, at the verified branch head.
    const rows = await attempts(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ mechanism: 'critic', verdict: 'pass', summary: 'looks correct' });
    expect(rows[0]!.inputOid).toMatch(/^[0-9a-f]{40}$/);

    expect(await verdictEvents(runId)).toEqual([
      { event: 'verification', mechanism: 'critic', verdict: 'pass', summary: 'looks correct' },
    ]);
  });

  it('AC3: a failing critic records feedback on attempt 1 and escalates after attempt 2', async () => {
    criticResult = { verdict: 'fail', summary: 'the change breaks the contract' };
    await server.app.ctx.workspaces.update(workspaceId, critic());
    const baseOidBefore = git(repoDir, 'rev-parse', 'main');
    const { taskId } = await createAndRun();

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}/attempts/current`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');
    expect(run.finishedAt).not.toBeNull();

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).toBe('escalated');

    const rows = await attempts(taskId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.mechanism === 'critic' && row.verdict === 'fail')).toBe(true);
    expect(rows.at(-1)).toMatchObject({ inputOid: run.verifiedHeadOid });
    expect(rows.at(-1)!.inputOid).toMatch(/^[0-9a-f]{40}$/);
    const timeline = await server.api('GET', `/api/tasks/${taskId}/attempts/timeline`);
    expect(timeline.body.attempts.map((attempt: { number: number; state: string }) => ({ number: attempt.number, state: attempt.state }))).toEqual([
      { number: 1, state: 'failed' },
      { number: 2, state: 'escalated' },
    ]);
    expect(timeline.body.attempts[0].feedback).toContain('the change breaks the contract');

    // The base branch never moved — nothing merged.
    expect(git(repoDir, 'rev-parse', 'main')).toBe(baseOidBefore);
  });

  it('AC3: an inconclusive critic consumes the same bounded Attempt loop', async () => {
    criticResult = { verdict: 'inconclusive', summary: 'cannot tell from the diff alone' };
    await server.app.ctx.workspaces.update(workspaceId, critic());
    const { taskId } = await createAndRun();

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}/attempts/current`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');

    const rows = await attempts(taskId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.mechanism === 'critic' && row.verdict === 'inconclusive')).toBe(true);
  });

  it('AC1: the critic verdict combines with the command verdict — command pass + critic fail still Escalates', async () => {
    criticResult = { verdict: 'fail', summary: 'logic is wrong despite green tests' };
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: [exitCommand(0)],
      ...critic(),
    });
    const { taskId } = await createAndRun();

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}/attempts/current`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).toBe('escalated');

    // Both verifiers run on each attempt. The critic failure is carried into
    // attempt 2, then the cap escalates without creating another ticket.
    const rows = await attempts(taskId);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => `${r.mechanism}:${r.verdict}`).sort()).toEqual([
      'command:pass',
      'command:pass',
      'critic:fail',
      'critic:fail',
    ]);
  });

  it('AC1: command pass + critic pass together merges the Run (all verifiers passed)', async () => {
    criticResult = { verdict: 'pass', summary: 'correct and complete' };
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: [exitCommand(0)],
      ...critic(),
    });
    const { taskId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run).toMatchObject({ state: 'completed' });

    // The one merge policy (ADR-0001, #381) runs a deterministic post-merge
    // check on the merged tip after the worktree merge lands — a second
    // `command` attempt, never the critic (it already reviewed this diff on
    // the candidate). So a worktree merge with a real command verifier now
    // persists three attempts, not two.
    const rows = await attempts(taskId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => `${r.mechanism}:${r.verdict}`).sort()).toEqual(['command:pass', 'command:pass', 'critic:pass']);
  });

  it('records implementation, verification, and review outcomes in the Attempt timeline', async () => {
    criticResult = { verdict: 'pass', summary: 'correct and complete' };
    const command = exitCommand(0);
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: [command],
      ...critic(),
    });
    const { taskId, runId } = await createAndRun();

    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? true : undefined;
    });

    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run.sessionRowId).not.toBe(runId);

    const response = await server.api('GET', `/api/tasks/${taskId}/attempts/timeline`);
    expect(response.status).toBe(200);
    expect(response.body.attempts).toHaveLength(1);
    expect(response.body.attempts[0].steps).toMatchObject([
      {
        type: 'rebase',
        state: 'passed',
        verdict: 'pass',
        logLocator: expect.stringMatching(/^git:rebase:.+@[0-9a-f]{40}$/),
      },
      {
        type: 'implementation',
        state: 'passed',
        verdict: 'pass',
        logLocator: `session:${run.sessionRowId}`,
      },
      {
        type: 'verification',
        state: 'passed',
        verdict: 'pass',
        command: command.command,
        logLocator: expect.stringMatching(/^verification_attempt:\d+$/),
      },
      {
        type: 'review',
        state: 'passed',
        verdict: 'pass',
        logLocator: expect.stringMatching(/^verification_attempt:\d+$/),
      },
    ]);
  });

  it('a configured critic with no committed implementation fails closed', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'direct',
      ...critic(),
    });
    writeFileSync(join(repoDir, 'uncommitted-critic.txt'), 'dirty\n');

    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ stopReason: 'end_turn' }),
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    const taskId = created.body.id as number;

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}/attempts/current`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');
    expect(run.verifiedHeadOid).toBeNull();

    const rows = await attempts(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ mechanism: 'critic', verdict: 'inconclusive', inputOid: '' });

    rmSync(join(repoDir, 'uncommitted-critic.txt'), { force: true });
  });

  it('issue #174 FIX 2: a critic with its own harness resolves that harness, not the builder task\'s', async () => {
    criticResult = { verdict: 'pass', summary: 'looks correct' };
    // A second configured harness so the critic can be pointed independently
    // of the builder's — native Runs default to task.harness 'claude'
    // (defaultConfig), so pinning the critic at 'codex' proves the override.
    await server.app.ctx.configStore.update({
      harnesses: {
        codex: { command: process.execPath, args: [], models: ['stub-model'], defaultModel: 'stub-model' },
      },
    });
    await server.app.ctx.workspaces.update(workspaceId, criticWithHarness('codex'));
    const { taskId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');
    expect(lastCriticHarnessId).toBe('codex');
  });
});
