import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

const exitCommand = (code: number): VerificationCommand =>
  verificationCommandSchema.parse({
    command: process.execPath,
    args: ['-e', `process.exit(${code})`],
    timeoutSeconds: 30,
  });

describe('command verifier end-to-end (issue #135)', () => {
  let server: TestServer;
  let repoDir: string;
  let workspaceId: number;

  beforeAll(async () => {
    repoDir = makeRepo();
    server = await startServer(stubHarness());
    const ws = (await server.app.ctx.workspaces.list())[0]!;
    workspaceId = ws.id;
    await server.app.ctx.workspaces.update(workspaceId, { workingDir: repoDir });
    await server.app.ctx.settingsStore.updateGlobal({ maxAttempts: 2 });
  });
  afterAll(async () => {
    await server.close();
    rmSync(repoDir, { recursive: true, force: true });
  });

  let implSeq = 0;
  async function createAndRun(
    scenario: Record<string, unknown> = { writeFiles: { [`impl-${++implSeq}.txt`]: 'implementation\n' } },
  ): Promise<{ taskId: number; attemptId: number }> {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify(scenario),
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    return { taskId: created.body.id, attemptId: started.body.id };
  }

  const attempts = async (taskId: number) => {
    const store = new VerificationAttemptStore(server.app.ctx.asyncDb);
    const taskAttempts = await server.app.ctx.attempts.listForTask(taskId);
    return (await Promise.all(taskAttempts.map((a) => store.list(a.id)))).flat();
  };
  const verdictEvents = async (attemptId: number) =>
    (await server.api('GET', `/api/attempts/${attemptId}/events`)).body.events
      .filter((e: any) => e.type === 'lifecycle' && e.payload.event === 'verification')
      .map((e: any) => e.payload);

  it('AC1/AC3/AC4/AC5: a passing command merges a native Run to done; the attempt records the verified head OID', async () => {
    await server.app.ctx.workspaces.update(workspaceId, { verificationCommand: [exitCommand(0)] });
    const { taskId, attemptId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run).toMatchObject({ state: 'completed' });
    expect(run.verifiedHeadOid).toMatch(/^[0-9a-f]{40}$/);

    const rows = await attempts(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ mechanism: 'command', verdict: 'pass' });
    expect(rows[0]!.inputOid).toMatch(/^[0-9a-f]{40}$/);

    expect(await verdictEvents(attemptId)).toEqual([
      { event: 'verification', mechanism: 'command', verdict: 'pass', summary: 'command exited 0' },
    ]);
  });

  it('a direct Run works in place: its verified commit is the base branch tip, with no private ref and no run branch', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'direct',
      verificationCommand: [exitCommand(0)],
    });
    const baseBefore = git(repoDir, 'rev-parse', 'main');
    const { taskId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run.verifiedHeadOid).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repoDir, 'rev-parse', 'main')).toBe(run.verifiedHeadOid);
    expect(run.verifiedHeadOid).not.toBe(baseBefore);
    expect(git(repoDir, 'for-each-ref', 'refs/harmonic/')).toBe('');
    expect(run.branch).toBeNull();
    expect(run.verifiedRef).toBeNull();
  });

  it('a pre-existing dirty tree does not fail a direct Run; its candidate is the agent\'s own commit', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'direct',
      verificationCommand: [exitCommand(0)],
    });
    writeFileSync(join(repoDir, 'operator-scratch.txt'), 'not the agent\n');

    const { taskId } = await createAndRun();
    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');
    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run.verifiedHeadOid).toMatch(/^[0-9a-f]{40}$/);

    rmSync(join(repoDir, 'operator-scratch.txt'), { force: true });
  });

  it('AC2/AC4: a failing command records feedback on attempt 1, then escalates after attempt 2', async () => {
    await server.app.ctx.workspaces.update(workspaceId, { verificationCommand: [exitCommand(1)] });
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
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mechanism: 'command', verdict: 'fail' }),
        expect.objectContaining({ mechanism: 'command', verdict: 'fail', inputOid: run.verifiedHeadOid }),
      ]),
    );
    const timeline = await server.api('GET', `/api/tasks/${taskId}/attempts/timeline`);
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
    const { taskId } = await createAndRun();

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}/attempts/current`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');

    const rows = await attempts(taskId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.verdict === 'inconclusive')).toBe(true);
    const timeline = await server.api('GET', `/api/tasks/${taskId}/attempts/timeline`);
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

    const { taskId } = await createAndRun({ stopReason: 'end_turn' });
    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}/attempts/current`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');
    expect(run.verifiedHeadOid).toBeNull();

    const rows = await attempts(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ mechanism: 'command', verdict: 'inconclusive', inputOid: '' });
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
    const { id: attemptId } = started.body as { id: number };
    await waitFor(async () => {
      const events = (await server.api('GET', `/api/attempts/${attemptId}/events`)).body.events;
      return events.some((event: { payload: { event?: string } }) => event.payload.event === 'commit-nudge') ? true : undefined;
    });
    await waitFor(async () => ((await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body.state !== 'running' ? true : undefined));
    const timeline = await server.api('GET', `/api/tasks/${taskId}/attempts/timeline`);
    expect(timeline.body.attempts).toHaveLength(1);
    expect(timeline.body.attempts[0]).toMatchObject({ number: 1 });
    rmSync(join(repoDir, 'nudge-me.txt'), { force: true });
  });

  it('a pass merges the Run onto the base as an ordinary merge commit (ADR-0001)', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'worktree',
      verificationCommand: [exitCommand(0)],
    });
    const { taskId } = await createAndRun();
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });

    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run.verifiedHeadOid).toBeTruthy();
    expect(git(repoDir, 'rev-parse', 'main^2')).toBe(run.verifiedHeadOid);
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

    const timeline = await server.api('GET', `/api/tasks/${taskId}/attempts/timeline`);
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
    const { taskId } = await createAndRun();
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}/attempts/current`);
      return body.state === 'failed' ? body : undefined;
    });

    const rows = await attempts(taskId);
    expect(rows.map((row) => `${row.mechanism}:${row.verdict}`)).toEqual([
      'command:pass',
      'command:fail',
      'command:pass',
      'command:fail',
    ]);
    expect(rows.map((row) => row.output.trim())).toEqual(['CMD1', 'CMD2', 'CMD1', 'CMD2']);
  });
});

describe('native merging (issue #138, ADR-0021)', () => {
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
  async function createAndRun(): Promise<{ taskId: number; attemptId: number }> {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { [`auto-accept-impl-${++implSeq}.txt`]: 'implementation\n' } }),
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    return { taskId: created.body.id, attemptId: started.body.id };
  }

  const attempts = async (taskId: number) => {
    const store = new VerificationAttemptStore(server.app.ctx.asyncDb);
    const taskAttempts = await server.app.ctx.attempts.listForTask(taskId);
    return (await Promise.all(taskAttempts.map((a) => store.list(a.id)))).flat();
  };

  it('a passing verification merges directly — there is no review gate to park at', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: [exitCommand(0)],
    });
    const { taskId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run.state).toBe('completed');
  });

  it('a pass merges under Harmonic\'s own merge fact, never the operator disposition', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: [exitCommand(0)],
    });
    const { taskId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run.state).toBe('completed');
    expect(run.finishedAt).not.toBeNull();

    const rows = await attempts(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ mechanism: 'command', verdict: 'pass' });

    const ticketAttempt = await new AttemptStore(server.app.ctx.asyncDb).getForTaskNumber(taskId, run.number);
    expect(ticketAttempt).toMatchObject({ state: 'passed', reason: 'agent-finish/unresolved' });
  });

  it('safety: a fail on every attempt Escalates — merging never rescues a red verdict', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: [exitCommand(1)],
    });
    const { taskId } = await createAndRun();

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}/attempts/current`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'escalated' ? body : undefined;
    });
    expect(task.escalationReason).toMatch(/failed/);
  });

  it('with NO verifier configured a run still merges — nothing to verify means nothing blocks', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: null,
    });
    const { taskId } = await createAndRun();

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run.state).toBe('completed');

    expect(await attempts(taskId)).toHaveLength(0);
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

    const run = (await server.api('GET', `/api/attempts/${started.body.id}`)).body;
    expect(run.state).toBe('completed');

    const baseOidAfter = git(repoDir, 'rev-parse', 'main');
    expect(baseOidAfter).not.toBe(baseOidBefore);
    const mergedFiles = git(repoDir, 'show', `${baseOidAfter}:auto-accept-feature.txt`);
    expect(mergedFiles).toBe('made by agent');
  });
});
