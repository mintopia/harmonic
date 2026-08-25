import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { verificationCommandSchema, verificationCriticSchema, type VerificationCommand } from '../src/config.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import { RunFactStore } from '../src/domain/run-facts.js';
import type { CriticHarnessDrive, CriticDriveRequest } from '../src/verification/critic.js';
import type { Verdict } from '../src/verification/critic-schema.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed file (same template
 * as tests/verification-critic.test.ts). */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-note-to-critic-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

const critic = () =>
  verificationCriticSchema.parse({ prompt: 'Review the diff for correctness.', model: 'stub-model' });

const exitCommand = (code: number): VerificationCommand =>
  verificationCommandSchema.parse({
    command: process.execPath,
    args: ['-e', `process.exit(${code})`],
    timeoutSeconds: 30,
  });

/**
 * Operator escape hatches for an escalated run (issue #191): "Adopt & review"
 * parks an escalated task's existing stranded candidate at awaiting-review
 * with no fresh builder run, and "Note-to-critic" re-runs only the critic
 * against that candidate with a human note, re-folding the verdict. Both
 * reuse the `parkForReview`/review-SLA machinery (`runner.ts`), so a passing
 * disposition is landable through the ordinary `ReviewService.accept` gate.
 */
describe('operator escape hatches for an escalated run (issue #191)', () => {
  let server: TestServer;
  let repoDir: string;
  let workspaceId: number;
  let criticResult: { verdict: Verdict; summary: string };
  /** The most recent critic prompt the fake drive was invoked with — lets a
   * test assert an operator note reached the critic's trusted preamble. */
  let lastCriticPrompt: string | undefined;

  const criticDrive: CriticHarnessDrive = {
    run: async (req: CriticDriveRequest) => {
      lastCriticPrompt = req.prompt;
      return { output: JSON.stringify(criticResult), permissionRequests: [] };
    },
  };

  beforeAll(async () => {
    repoDir = makeRepo();
    server = await startServer(stubHarness(), { criticDrive });
    const ws = (await server.app.ctx.workspaces.list())[0]!;
    workspaceId = ws.id;
    await server.app.ctx.workspaces.update(workspaceId, { workingDir: repoDir });
    await server.app.ctx.configStore.update({ maxAttempts: 2 });
  });
  afterAll(async () => {
    await server.close();
    rmSync(repoDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    criticResult = { verdict: 'fail', summary: 'not good enough yet' };
    lastCriticPrompt = undefined;
    await server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'worktree',
      verificationCommand: null,
      verificationCritic: null,
      verificationAutoAccept: null,
    });
  });

  async function createAndRun(): Promise<{ taskId: number; runId: number }> {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'note-to-critic-feature.txt': 'work\n' } }),
      workingDir: repoDir,
      isolationMode: 'worktree',
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    return { taskId: created.body.id, runId: started.body.id };
  }

  /** Drive a fresh task+run to escalation via a failing critic, waiting for
   * both the run and the task to settle. */
  async function escalateViaCriticFail(): Promise<{ taskId: number; runId: number }> {
    await server.app.ctx.workspaces.update(workspaceId, { verificationCritic: critic() });
    const { taskId, runId } = await createAndRun();
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.escalated ? body : undefined;
    });
    expect(task.state).toBe('ready');
    expect(task.escalated).toBe(true);
    return { taskId, runId };
  }

  const attempts = (runId: number) => new VerificationAttemptStore(server.app.ctx.asyncDb).list(runId);
  const facts = (runId: number) => new RunFactStore(server.app.ctx.asyncDb).list(runId);

  describe('adoptForReview / POST /tasks/:id/adopt-review', () => {
    it('parks the existing candidate at awaiting-review, non-terminal, with the escalated flag cleared', async () => {
      const { taskId, runId } = await escalateViaCriticFail();
      const runBefore = (await server.api('GET', `/api/runs/${runId}`)).body;
      expect(runBefore.candidateOid).toBeTruthy();

      const res = await server.api('POST', `/api/tasks/${taskId}/adopt-review`);
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('awaiting-review');
      expect(res.body.escalated).toBe(false);

      const run = (await server.api('GET', `/api/runs/${runId}`)).body;
      expect(run.state).toBe('running');
      expect(run.phase).toBe('review');
      expect(run.finishedAt).toBeNull();
      expect(run.candidateOid).toBe(runBefore.candidateOid);
    });

    // Regression for issue #191: `ReviewService.accept`'s land call now
    // appends an `operator-accept` run_fact (`landing-coordinator.ts`'s
    // `landFactType` param), which `DISPOSITION_PRECEDENCE`
    // (`run-disposition.ts`) ranks just above `escalate` — an explicit
    // operator Accept outranks the OLDER `escalate` fact still sitting on a
    // re-parked Run's log, so `RunSettleCoordinator.settle`'s whole-log
    // precedence replay resolves to the accept, not the historical escalate.
    // The merge that `LandingCoordinator.land`'s effect loop runs and the
    // Task/Run bookkeeping that follows now agree: both land.
    it('adopt then accept lands AND completes — an operator accept outranks the retained escalate fact', async () => {
      const baseOidBefore = git(repoDir, 'rev-parse', 'main');
      const { taskId, runId } = await escalateViaCriticFail();

      const adopted = await server.api('POST', `/api/tasks/${taskId}/adopt-review`);
      expect(adopted.status).toBe(200);
      expect(adopted.body.state).toBe('awaiting-review');

      const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
      expect(accepted.status).toBe(200);
      expect(accepted.body.state).toBe('completed');
      expect(accepted.body.escalated).toBe(false);

      const run = (await server.api('GET', `/api/runs/${runId}`)).body;
      expect(run.state).toBe('completed');
      expect(run.phase).toBe('terminal');
      expect(run.review).toBe('accepted');

      // The winning disposition is the new `operator-accept` fact, not the
      // retained `escalate` — both are on the log, but precedence now
      // resolves to the accept.
      const runFacts = await facts(runId);
      expect(runFacts.some((f) => f.type === 'escalate')).toBe(true);
      expect(runFacts.some((f) => f.type === 'operator-accept')).toBe(true);

      // The merge actually happened: the base branch moved.
      expect(git(repoDir, 'rev-parse', 'main')).not.toBe(baseOidBefore);
    });

    it('boot/SLA reconcile does not revert an adopted-but-unaccepted run', async () => {
      const { taskId, runId } = await escalateViaCriticFail();

      const adopted = await server.api('POST', `/api/tasks/${taskId}/adopt-review`);
      expect(adopted.status).toBe(200);
      expect(adopted.body.state).toBe('awaiting-review');

      // The boot-time orphan sweep excludes review-parked Runs by design
      // (`RunStore.markInterrupted`'s doc comment) — it must not fail an
      // adopted-but-unaccepted Run out from under a human still deciding.
      server.app.ctx.runs.markInterrupted();
      // The review-SLA sweep only settles a Run whose deadline has lapsed;
      // with a deadline safely in the future, it must leave this Run alone.
      server.app.ctx.review.sweepExpiredReviews(Date.now());

      const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      expect(task.state).toBe('awaiting-review');
      expect(task.escalated).toBe(false);

      const run = (await server.api('GET', `/api/runs/${runId}`)).body;
      expect(run.state).toBe('running');
      expect(run.phase).toBe('review');
    });

    it('409s invalid_state when the task is not escalated', async () => {
      // An ordinary awaiting-review task (a passing critic) is not escalated.
      criticResult = { verdict: 'pass', summary: 'looks correct' };
      await server.app.ctx.workspaces.update(workspaceId, { verificationCritic: critic() });
      const { taskId } = await createAndRun();
      const task = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'awaiting-review' ? body : undefined;
      });
      expect(task.escalated).toBe(false);

      const res = await server.api('POST', `/api/tasks/${taskId}/adopt-review`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('invalid_state');
    });

    it('409s conflict when the escalated run never reached a candidate snapshot', async () => {
      // Direct mode + a dirty tree skips the candidate snapshot entirely
      // (mirrors tests/verification-critic.test.ts's equivalent case).
      await server.app.ctx.workspaces.update(workspaceId, {
        isolationMode: 'direct',
        verificationCritic: critic(),
      });
      writeFileSync(join(repoDir, 'uncommitted-note-to-critic.txt'), 'dirty\n');
      try {
        const created = await server.api('POST', '/api/tasks', {
          prompt: JSON.stringify({ stopReason: 'end_turn' }),
        });
        expect(created.status).toBe(201);
        const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
        expect(started.status).toBe(201);
        const runId = started.body.id;
        await waitFor(async () => {
          const { body } = await server.api('GET', `/api/runs/${runId}`);
          return body.state === 'failed' ? body : undefined;
        });
        const task = await waitFor(async () => {
          const { body } = await server.api('GET', `/api/tasks/${created.body.id}`);
          return body.escalated ? body : undefined;
        });
        expect(task.escalated).toBe(true);

        const res = await server.api('POST', `/api/tasks/${created.body.id}/adopt-review`);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('conflict');
      } finally {
        rmSync(join(repoDir, 'uncommitted-note-to-critic.txt'), { force: true });
      }
    });
  });

  describe('reverifyWithNote / POST /tasks/:id/note-to-critic', () => {
    it('a passing re-reviewed critic parks the task at awaiting-review (never auto-landed)', async () => {
      const { taskId, runId } = await escalateViaCriticFail();
      expect(await attempts(runId)).toHaveLength(2);

      criticResult = { verdict: 'pass', summary: 'the operator note resolved my concern' };
      const res = await server.api('POST', `/api/tasks/${taskId}/note-to-critic`, {
        note: 'The timeout is intentional; see the linked ticket.',
      });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('awaiting-review');
      expect(res.body.escalated).toBe(false);

      // The operator note reached the critic's trusted preamble.
      expect(lastCriticPrompt).toContain('The timeout is intentional; see the linked ticket.');

      const rows = await attempts(runId);
      expect(rows).toHaveLength(3);
      expect(rows[2]).toMatchObject({ mechanism: 'critic', verdict: 'pass' });

      const run = (await server.api('GET', `/api/runs/${runId}`)).body;
      expect(run.state).toBe('running');
      expect(run.phase).toBe('review');
    });

    it('a note-flipped-to-proceed park then accept lands (issue #191)', async () => {
      const { taskId, runId } = await escalateViaCriticFail();

      criticResult = { verdict: 'pass', summary: 'the operator note resolved my concern' };
      const parked = await server.api('POST', `/api/tasks/${taskId}/note-to-critic`, {
        note: 'The timeout is intentional; see the linked ticket.',
      });
      expect(parked.status).toBe(200);
      expect(parked.body.state).toBe('awaiting-review');

      const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
      expect(accepted.status).toBe(200);
      expect(accepted.body.state).toBe('completed');
      expect(accepted.body.escalated).toBe(false);

      const run = (await server.api('GET', `/api/runs/${runId}`)).body;
      expect(run.state).toBe('completed');
      expect(run.phase).toBe('terminal');
      expect((await facts(runId)).some((f) => f.type === 'operator-accept')).toBe(true);
    });

    it('an inconclusive re-reviewed critic leaves the task escalated, with the attempt recorded', async () => {
      const { taskId, runId } = await escalateViaCriticFail();

      criticResult = { verdict: 'inconclusive', summary: 'still cannot tell' };
      const res = await server.api('POST', `/api/tasks/${taskId}/note-to-critic`, {
        note: 'Please look again at the retry logic.',
      });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('ready');
      expect(res.body.escalated).toBe(true);

      const rows = await attempts(runId);
      expect(rows).toHaveLength(3);
      expect(rows[2]).toMatchObject({ mechanism: 'critic', verdict: 'inconclusive' });
    });

    it('a prior command failure still blocks even when the re-reviewed critic passes', async () => {
      await server.app.ctx.workspaces.update(workspaceId, { verificationCommand: exitCommand(1) });
      criticResult = { verdict: 'fail', summary: 'original critic verdict' };
      const { taskId, runId } = await escalateViaCriticFail();
      expect((await attempts(runId)).map((a) => `${a.mechanism}:${a.verdict}`).sort()).toEqual([
        'command:fail',
        'command:fail',
        'critic:fail',
        'critic:fail',
      ]);

      criticResult = { verdict: 'pass', summary: 'the note resolved the critic concern' };
      const res = await server.api('POST', `/api/tasks/${taskId}/note-to-critic`, {
        note: 'The critic concern is addressed; please re-check.',
      });
      expect(res.status).toBe(200);
      // Still blocked/escalated — the stored command failure outranks a fresh
      // critic pass; a human note can never silently override it.
      expect(res.body.state).toBe('ready');
      expect(res.body.escalated).toBe(true);

      const rows = await attempts(runId);
      expect(rows).toHaveLength(5);
      expect(rows[4]).toMatchObject({ mechanism: 'critic', verdict: 'pass' });
    });

    it('400s when the note is empty', async () => {
      const { taskId } = await escalateViaCriticFail();
      const res = await server.api('POST', `/api/tasks/${taskId}/note-to-critic`, { note: '' });
      expect(res.status).toBe(400);
    });

    it('409s invalid_state when the task is not escalated', async () => {
      criticResult = { verdict: 'pass', summary: 'looks correct' };
      await server.app.ctx.workspaces.update(workspaceId, { verificationCritic: critic() });
      const { taskId } = await createAndRun();
      await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'awaiting-review' ? body : undefined;
      });

      const res = await server.api('POST', `/api/tasks/${taskId}/note-to-critic`, { note: 'anything' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('invalid_state');
    });

    it('409s conflict when the escalated run never reached a candidate snapshot', async () => {
      await server.app.ctx.workspaces.update(workspaceId, {
        isolationMode: 'direct',
        verificationCritic: critic(),
      });
      writeFileSync(join(repoDir, 'uncommitted-note-to-critic-2.txt'), 'dirty\n');
      try {
        const created = await server.api('POST', '/api/tasks', {
          prompt: JSON.stringify({ stopReason: 'end_turn' }),
        });
        expect(created.status).toBe(201);
        const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
        expect(started.status).toBe(201);
        const runId = started.body.id;
        await waitFor(async () => {
          const { body } = await server.api('GET', `/api/runs/${runId}`);
          return body.state === 'failed' ? body : undefined;
        });
        await waitFor(async () => {
          const { body } = await server.api('GET', `/api/tasks/${created.body.id}`);
          return body.escalated ? body : undefined;
        });

        const res = await server.api('POST', `/api/tasks/${created.body.id}/note-to-critic`, { note: 'anything' });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('conflict');
      } finally {
        rmSync(join(repoDir, 'uncommitted-note-to-critic-2.txt'), { force: true });
      }
    });

    it('409s invalid_state when no critic is configured for the workspace', async () => {
      await server.app.ctx.workspaces.update(workspaceId, { verificationCommand: exitCommand(1) });
      const { taskId } = await escalateViaCriticFail(); // still uses a critic during escalation for a candidate
      // Now strip the critic before the operator's re-verify call.
      await server.app.ctx.workspaces.update(workspaceId, { verificationCritic: null });

      const res = await server.api('POST', `/api/tasks/${taskId}/note-to-critic`, { note: 'anything' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('invalid_state');
    });
  });
});
