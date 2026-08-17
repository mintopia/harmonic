import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { verificationCommandSchema, type VerificationCommand } from '../src/config.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import { turnQueue } from '../src/db/schema.js';

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
 * Bounded self-heal end to end (issue #137, reliability-design Unit B), driven
 * through the stub harness at the Runner seam: an actionable verification fail
 * routes a corrective builder turn back through the per-Session turn queue,
 * re-enters `validating`, and reruns the FULL verifier suite; an inconclusive
 * never heals; exhausting the heal budget Escalates.
 */
describe('verification self-heal end-to-end (issue #137)', () => {
  let server: TestServer;
  let repoDir: string;
  let workspaceId: number;

  beforeAll(async () => {
    repoDir = makeRepo();
    server = await startServer(stubHarness());
    const ws = server.app.ctx.workspaces.list()[0]!;
    workspaceId = ws.id;
    server.app.ctx.workspaces.update(workspaceId, { workingDir: repoDir });
  });
  afterAll(async () => {
    await server.close();
    rmSync(repoDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    // Reset per-test verifier config + heal budget; each test sets its own.
    server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: null,
      verificationAutoAccept: null,
    });
    server.app.ctx.configStore.update({ verification: { maxSelfHeals: 1 } });
  });

  const attempts = (runId: number) => new VerificationAttemptStore(server.app.ctx.db).list(runId);
  const selfHealTurns = (runId: number) =>
    server.app.ctx.db.select().from(turnQueue).where(eq(turnQueue.runId, runId)).all();

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

  it('AC1/AC2/AC5: an actionable fail heals once, re-verifies the full suite, and lands (fail→heal→pass)', async () => {
    server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: markerCommand('ok'),
      verificationAutoAccept: true,
    });
    const baseOidBefore = git(repoDir, 'rev-parse', 'main');

    // Turn 0 writes a marker the verifier rejects; the self-heal turn (turn 1)
    // overwrites it with the passing value.
    const { taskId, runId } = await runWorktreeTask({
      turns: [{ writeFiles: { 'marker.txt': 'bad\n' } }, { writeFiles: { 'marker.txt': 'ok\n' } }],
    });

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'completed' ? body : undefined;
    });
    expect(task.state).toBe('completed');

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.state).toBe('completed');
    expect(run.phase).toBe('terminal');

    // The healed work landed: the base branch moved and carries the fixed marker.
    const baseOidAfter = git(repoDir, 'rev-parse', 'main');
    expect(baseOidAfter).not.toBe(baseOidBefore);
    expect(git(repoDir, 'show', `${baseOidAfter}:marker.txt`)).toBe('ok');

    // AC2: the FULL suite reran — two attempts against two candidates: the first
    // fail, then the heal's pass (not just the failed check re-run).
    const rows = attempts(runId);
    expect(rows.map((r) => r.verdict)).toEqual(['fail', 'pass']);
    expect(rows[0]!.inputOid).not.toBe(rows[1]!.inputOid); // a fresh candidate per turn

    // AC1: exactly one self-heal turn was enqueued via the turn queue, and it
    // settled done.
    const turns = selfHealTurns(runId);
    expect(turns).toHaveLength(1);
    expect(turns[0]!).toMatchObject({ purpose: 'self-heal', status: 'done' });
    expect(turns[0]!.sessionId).toBe(`run-${runId}`); // stable Session anchor across heals

    // The phase re-entry is recorded, not inferred: the heal turn logs a fresh
    // `executing` before re-running validating→verifying (so the whole phase
    // sequence is reconstructable from the event log).
    const phases = (await server.api('GET', `/api/runs/${runId}/events`)).body.events
      .filter((e: any) => e.type === 'lifecycle' && e.payload.event === 'phase')
      .map((e: any) => e.payload.phase);
    expect(phases).toEqual(['validating', 'verifying', 'executing', 'validating', 'verifying', 'landing']);
  });

  it('AC4: an inconclusive verdict never heals — it Escalates immediately with cause, no self-heal turn', async () => {
    server.app.ctx.workspaces.update(workspaceId, { verificationCommand: inconclusiveCommand() });

    const { taskId, runId } = await runWorktreeTask({ writeFiles: { 'marker.txt': 'anything\n' } });

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.escalated ? body : undefined;
    });
    expect(task.escalated).toBe(true);

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.state).toBe('failed');
    expect(run.phase).not.toBe('review');
    expect(run.phase).not.toBe('landing');

    // Exactly one verifier attempt (inconclusive) — no heal was attempted.
    const rows = attempts(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe('inconclusive');
    // And no self-heal turn was ever enqueued.
    expect(selfHealTurns(runId)).toHaveLength(0);
  });

  it('AC3: self-heal is bounded — an actionable fail that never heals exhausts the budget and Escalates', async () => {
    server.app.ctx.workspaces.update(workspaceId, { verificationCommand: alwaysFail() });
    server.app.ctx.configStore.update({ verification: { maxSelfHeals: 1 } });

    const { taskId, runId } = await runWorktreeTask({ writeFiles: { 'marker.txt': 'bad\n' } });

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');
    expect(run.phase).not.toBe('review');
    expect(run.phase).not.toBe('landing');

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.escalated).toBe(true);

    // Budget of 1: the first turn fails, one heal turn runs and also fails, then
    // the Run Escalates — exactly two attempts and exactly one self-heal turn.
    const rows = attempts(runId);
    expect(rows.map((r) => r.verdict)).toEqual(['fail', 'fail']);
    expect(selfHealTurns(runId)).toHaveLength(1);
  });

  it('maxSelfHeals: 0 disables self-heal — an actionable fail Escalates on the first turn, no heal turn', async () => {
    server.app.ctx.workspaces.update(workspaceId, { verificationCommand: alwaysFail() });
    server.app.ctx.configStore.update({ verification: { maxSelfHeals: 0 } });

    const { taskId, runId } = await runWorktreeTask({ writeFiles: { 'marker.txt': 'bad\n' } });

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.escalated).toBe(true);

    expect(attempts(runId).map((r) => r.verdict)).toEqual(['fail']);
    expect(selfHealTurns(runId)).toHaveLength(0);
  });
});
