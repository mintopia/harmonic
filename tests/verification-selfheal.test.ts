import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { verificationCommandSchema, type VerificationCommand } from '../src/config.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import { AttemptStore } from '../src/domain/attempts.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed file. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-selfheal-e2e-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** A verifier that passes iff the candidate's `marker.txt` reads exactly `want`.
 * The command runs in a disposable checkout of the frozen candidate, so it sees
 * whatever the builder wrote into the worktree that turn. */
const markerCommand = (want: string): VerificationCommand =>
  verificationCommandSchema.parse({
    command: process.execPath,
    args: [
      '-e',
      `let v='';try{v=require('fs').readFileSync('marker.txt','utf8').trim()}catch{};process.exit(v===${JSON.stringify(want)}?0:1)`,
    ],
    timeoutSeconds: 30,
  });

/** A verifier that always fails (exit 1) — an actionable fail on every run. */
const alwaysFail = (): VerificationCommand =>
  verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutSeconds: 30 });

/** A verifier whose executable doesn't exist → a spawn error the command
 * verifier reads as `inconclusive` (infra doubt), never an actionable fail. */
const inconclusiveCommand = (): VerificationCommand =>
  verificationCommandSchema.parse({ command: join(tmpdir(), 'harmonic-no-such-verify-binary-xyz'), args: [], timeoutSeconds: 30 });

/**
 * Bounded Attempt loop end to end (issue #310), driven
 * through the stub harness at the Runner seam: an actionable verification fail
 * drives a corrective builder turn through the next Attempt in the same Run,
 * opens a fresh Implementation Step, and reruns the FULL verifier suite; an
 * inconclusive never heals; exhausting the heal budget Escalates.
 */
describe('verification Attempt loop end-to-end (issue #310)', () => {
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
  beforeEach(async () => {
    // Reset per-test verifier config and cap; each test sets its own.
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: null,
      maxAttempts: null,
    });
    await server.app.ctx.configStore.update({ maxAttempts: 2 });
  });

  // `verification_attempts` is keyed off `attempt_id`, not `run_id`
  // (ADR-0001 #388 S-F): a self-heal loop's failed attempts share one Run row
  // but each get their own Attempt row, so "this Run's verification
  // attempts" now folds the log across every Attempt of the Run's Task.
  const attempts = async (runId: number) => {
    const store = new VerificationAttemptStore(server.app.ctx.asyncDb);
    const run = await server.app.ctx.attempts.get(runId);
    const taskAttempts = await server.app.ctx.attempts.listForTask(run.taskId);
    return (await Promise.all(taskAttempts.map((a) => store.list(a.id)))).flat();
  };
  const ticketAttempts = (taskId: number) => new AttemptStore(server.app.ctx.asyncDb).listForTask(taskId);

  async function runWorktreeTask(prompt: unknown): Promise<{ taskId: number; runId: number }> {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify(prompt),
      workingDir: repoDir,
      isolationMode: 'worktree',
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    return { taskId: created.body.id, runId: started.body.id };
  }

  it('AC1/AC2: an actionable fail creates Attempt N+1 with feedback and re-verifies', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: [markerCommand('ok')],
    });
    const baseOidBefore = git(repoDir, 'rev-parse', 'main');

    // Turn 0 writes a marker the verifier rejects; attempt 2
    // overwrites it with the passing value.
    const { taskId, runId } = await runWorktreeTask({
      turns: [{ writeFiles: { 'marker.txt': 'bad\n' } }, { writeFiles: { 'marker.txt': 'ok\n' } }],
    });

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run.state).toBe('completed');

    // The healed work merged: the base branch moved and carries the fixed marker.
    const baseOidAfter = git(repoDir, 'rev-parse', 'main');
    expect(baseOidAfter).not.toBe(baseOidBefore);
    expect(git(repoDir, 'show', `${baseOidAfter}:marker.txt`)).toBe('ok');

    // AC2: the FULL suite reran — two attempts against two candidates: the first
    // fail, then the heal's pass (not just the failed check re-run). A third
    // `pass` follows: the one merge policy's post-merge check (ADR-0001, #381)
    // re-running the same deterministic verifier against the merged tip.
    const rows = await attempts(runId);
    expect(rows.map((r) => r.verdict)).toEqual(['fail', 'pass', 'pass']);
    expect(rows[0]!.inputOid).not.toBe(rows[1]!.inputOid); // a fresh candidate per turn

    const attemptsByTicket = await ticketAttempts(taskId);
    expect(attemptsByTicket).toMatchObject([
      { number: 1, state: 'failed' },
      { number: 2, state: 'passed' },
    ]);
    expect(attemptsByTicket[0]!.feedback).toContain('verifier command failed');

    // The Step re-entry is recorded, not inferred: the heal turn (Attempt 2)
    // opens its own fresh Implementation Step before re-running verification —
    // never reusing or skipping Attempt 1's, so the whole Step sequence per
    // Attempt is reconstructable from the timeline (ADR-0001 Vocabulary).
    const stepTypesByAttempt = await Promise.all(
      attemptsByTicket.map(async (a) => (await server.app.ctx.attempts.listSteps(a.id)).map((s) => s.type)),
    );
    expect(stepTypesByAttempt).toEqual([
      ['rebase', 'implementation', 'verification'],
      ['rebase', 'implementation', 'verification'],
    ]);
  });

  /** The durable Session an Attempt's implementation Task points at (`session:<row id>`). */
  async function implementationSession(attemptId: number) {
    const steps = await new AttemptStore(server.app.ctx.asyncDb).listSteps(attemptId);
    const locator = steps.find((step) => step.type === 'implementation')?.logLocator ?? '';
    const match = /^session:(\d+)$/.exec(locator);
    expect(match, `implementation locator ${locator}`).not.toBeNull();
    return server.app.ctx.sessions.get(Number(match![1]));
  }

  /** Attempt 1 reports `inputTokens` as its context footprint; the rule (a raw
   * 20-token reuse limit) decides Attempt 2's Session from that. */
  async function runContinuationScenario(inputTokens: number) {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: [markerCommand('ok')],
      contextReuseTokenLimit: 20,
    });
    const { taskId } = await runWorktreeTask({
      turns: [
        { writeFiles: { 'marker.txt': 'bad\n' }, usage: { inputTokens, outputTokens: 1 } },
        { writeFiles: { 'marker.txt': 'ok\n' } },
      ],
    });
    await waitFor(async () => ((await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done' ? true : undefined));
    const attemptsByTicket = await ticketAttempts(taskId);
    expect(attemptsByTicket.map((a) => a.state)).toEqual(['failed', 'passed']);
    const [first, second] = await Promise.all([implementationSession(attemptsByTicket[0]!.id), implementationSession(attemptsByTicket[1]!.id)]);
    // Each self-heal turn is its own new Attempt row (ADR-0001 #388 S-G), so
    // the "current state of this execution" read follows forward via the Task,
    // exactly like `/api/tasks/:id/attempts/current` does.
    const run = await server.app.ctx.attempts.currentForTask(taskId);
    const reloaded = (await server.api('GET', `/api/attempts/${run.id}/events`)).body.events
      .filter((event: { payload: { event?: string } }) => event.payload.event === 'session-reloaded')
      .map((event: { payload: { sessionId: string } }) => event.payload.sessionId);
    return { continuation: JSON.parse(attemptsByTicket[1]!.continuation!), first, second, run, reloaded };
  }

  it('continues the prior Session below the threshold: attempt 2 reloads the same session id', async () => {
    const { continuation, first, second, run, reloaded } = await runContinuationScenario(10);
    expect(continuation).toMatchObject({ path: 'continued-session', reason: 'continued-within-limits', contextTokens: 10, contextReuseTokenLimit: 20 });
    expect(second.id).toBe(first.id);
    expect(reloaded).toEqual([first.harnessSessionId]);
    expect(run.sessionId).toBe(first.harnessSessionId);
    expect(run.prompt).toContain('## Previous attempt failed — fix required (self-heal 1)');
    expect(run.prompt).not.toContain('## Prior session (condensed)');
  });

  it('starts a condensed Session at/above the threshold: fresh session id, condensed section after the corrective feedback', async () => {
    const { continuation, first, second, run, reloaded } = await runContinuationScenario(90);
    expect(continuation).toMatchObject({ path: 'new-session-condensed', reason: 'context-tokens', contextTokens: 90, contextReuseTokenLimit: 20 });
    expect(second.id).not.toBe(first.id);
    expect(second.harnessSessionId).not.toBe(first.harnessSessionId);
    expect(reloaded).toEqual([]);
    expect(run.sessionId).toBe(second.harnessSessionId);
    // The scenario head stays parseable; the condensed context is its own section
    // after the corrective feedback, naming the Session it condenses.
    const prompt = run.prompt!;
    expect(JSON.parse(prompt.split('\n\n## Previous attempt failed')[0]!)).toHaveProperty('turns');
    const verification = prompt.indexOf('## Previous attempt failed — fix required (self-heal 1)');
    const condensed = prompt.indexOf('## Prior session (condensed)');
    expect(verification).toBeGreaterThan(-1);
    expect(condensed).toBeGreaterThan(verification);
    expect(prompt.slice(condensed)).toContain(first.harnessSessionId);
  });

  it('AC4: an inconclusive verdict consumes an attempt and escalates only at the cap', async () => {
    await server.app.ctx.workspaces.update(workspaceId, { verificationCommand: [inconclusiveCommand()] });

    const { taskId, runId } = await runWorktreeTask({ writeFiles: { 'marker.txt': 'anything\n' } });

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'escalated' ? body : undefined;
    });
    expect(task.state).toBe('escalated');

    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run.state).toBe('failed');

    // The verifier runs once per Attempt and the failed Attempt retains feedback.
    const rows = await attempts(runId);
    expect(rows.map((row) => row.verdict)).toEqual(['inconclusive', 'inconclusive']);
    expect(await ticketAttempts(taskId)).toMatchObject([
      { number: 1, state: 'failed' },
      { number: 2, state: 'escalated' },
    ]);
  });

  it('AC3: an actionable fail exhausts maxAttempts and escalates', async () => {
    await server.app.ctx.workspaces.update(workspaceId, { verificationCommand: [alwaysFail()] });
    await server.app.ctx.configStore.update({ maxAttempts: 2 });

    const { taskId, runId } = await runWorktreeTask({ writeFiles: { 'marker.txt': 'bad\n' } });

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}/attempts/current`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).toBe('escalated');

    // Both implementation attempts fail; no third attempt is created.
    const rows = await attempts(runId);
    expect(rows.map((r) => r.verdict)).toEqual(['fail', 'fail']);
    expect(await ticketAttempts(taskId)).toMatchObject([
      { number: 1, state: 'failed' },
      { number: 2, state: 'escalated' },
    ]);
  });

  it('a workspace maxAttempts override escalates after its first failed attempt', async () => {
    await server.app.ctx.workspaces.update(workspaceId, { verificationCommand: [alwaysFail()] });
    await server.app.ctx.configStore.update({ maxAttempts: 3 });
    await server.app.ctx.workspaces.update(workspaceId, { maxAttempts: 1 });

    const { taskId, runId } = await runWorktreeTask({ writeFiles: { 'marker.txt': 'bad\n' } });

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}/attempts/current`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).toBe('escalated');

    expect((await attempts(runId)).map((r) => r.verdict)).toEqual(['fail']);
    expect(await ticketAttempts(taskId)).toMatchObject([{ number: 1, state: 'escalated' }]);
  });
});
