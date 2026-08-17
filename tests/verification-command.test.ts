import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { verificationCommandSchema, type VerificationCommand } from '../src/config.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';

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
    const ws = server.app.ctx.workspaces.list()[0]!;
    workspaceId = ws.id;
    server.app.ctx.workspaces.update(workspaceId, { workingDir: repoDir });
  });
  afterAll(async () => {
    await server.close();
    rmSync(repoDir, { recursive: true, force: true });
  });

  async function createAndRun(): Promise<{ taskId: number; runId: number }> {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ stopReason: 'end_turn' }),
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

  it('AC1/AC3/AC4/AC5: a passing command lets a native Run park for review, attempt records the frozen candidate OID', async () => {
    server.app.ctx.workspaces.update(workspaceId, { verificationCommand: exitCommand(0) });
    const { taskId, runId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'awaiting-review' ? body : undefined;
    });
    expect(task.state).toBe('awaiting-review');

    const run = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(run.phase).toBe('review');
    expect(run.candidateOid).toBeTruthy();

    // AC3/AC5: the attempt is persisted at exactly the frozen candidate OID.
    const rows = attempts(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ mechanism: 'command', verdict: 'pass' });
    expect(rows[0]!.inputOid).toBe(run.candidateOid);

    expect(await verdictEvents(runId)).toEqual([
      { event: 'verification', mechanism: 'command', verdict: 'pass', summary: 'command exited 0' },
    ]);
  });

  it('AC2/AC4: a failing command Escalates the Run and never lands (broken work never lands)', async () => {
    server.app.ctx.workspaces.update(workspaceId, { verificationCommand: exitCommand(1) });
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

    const rows = attempts(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mechanism: 'command', verdict: 'fail', inputOid: run.candidateOid });
  });

  it('AC2/AC4: a missing command is inconclusive → Escalates (infra doubt fails safe)', async () => {
    server.app.ctx.workspaces.update(workspaceId, {
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

    const rows = attempts(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe('inconclusive');
  });

  // Kept last: it dirties the shared repo working tree, which would suppress the
  // candidate snapshot for any run created after it.
  it('AC2/AC4: verifier configured but no candidate snapshot (dirty direct context) → inconclusive → Escalate', async () => {
    // Direct mode + a dirty working tree means `validating` skips the snapshot
    // (`snapshotCandidate` → 'dirty-direct-context'), so there is no candidate
    // to verify — infra doubt the gate must Escalate on, not silently pass.
    server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'direct',
      verificationCommand: exitCommand(0),
    });
    writeFileSync(join(repoDir, 'uncommitted.txt'), 'dirty\n');

    const { taskId, runId } = await createAndRun();
    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${runId}`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');
    expect(run.phase).not.toBe('review');
    expect(run.candidateOid).toBeNull();

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).not.toBe('awaiting-review');

    const rows = attempts(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ mechanism: 'command', verdict: 'inconclusive', inputOid: '' });
  });
});
