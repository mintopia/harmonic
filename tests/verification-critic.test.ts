import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { verificationCommandSchema, type VerificationCommand, type HarnessId } from '../src/config.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import { resetCodeIndexAvailabilityForTest } from '../src/execution/code-index.js';
import type { CriticHarnessDrive } from '../src/verification/critic.js';
import type { Verdict } from '../src/verification/critic-schema.js';

const FAKE_CODE_INDEX_CLI = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, args.join(' ') + '\\n');
if (args[0] === 'list-repos') process.stdout.write(JSON.stringify({ repos: [] }));
process.exit(0);
`;

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

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

const critic = () => ({ reviewEnabled: true, reviewPrompt: 'Review the diff for correctness.', reviewModel: 'stub-model' });

const criticWithHarness = (harness: HarnessId) => ({ ...critic(), reviewHarness: harness });

const exitCommand = (code: number): VerificationCommand =>
  verificationCommandSchema.parse({
    command: process.execPath,
    args: ['-e', `process.exit(${code})`],
    timeoutSeconds: 30,
  });

describe('agent critic end-to-end (issue #164)', () => {
  let server: TestServer;
  let repoDir: string;
  let workspaceId: number;
  let criticResult: { verdict: Verdict; summary: string };
  let lastCriticHarnessId: string | undefined;
  let lastCriticCwd: string | undefined;
  let codeIndexDir: string;
  let codeIndexLog: string;
  const prevCodeIndexCli = process.env.HARMONIC_CODE_INDEX_CLI;

  const criticDrive: CriticHarnessDrive = {
    run: async (req) => {
      lastCriticHarnessId = req.harnessId;
      lastCriticCwd = req.cwd;
      return { output: JSON.stringify(criticResult), permissionRequests: [] };
    },
  };

  const indexCountFor = (absPath: string): number =>
    readFileSync(codeIndexLog, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('index ') && line.endsWith(resolve(absPath)))
      .length;

  beforeAll(async () => {
    repoDir = makeRepo();
    codeIndexDir = mkdtempSync(join(tmpdir(), 'harmonic-critic-idx-'));
    const cliPath = join(codeIndexDir, 'fake-code-index.cjs');
    writeFileSync(cliPath, FAKE_CODE_INDEX_CLI);
    chmodSync(cliPath, 0o755);
    codeIndexLog = join(codeIndexDir, 'calls.log');
    writeFileSync(codeIndexLog, '');
    process.env.HARMONIC_CODE_INDEX_CLI = cliPath;
    process.env.FAKE_CLI_LOG = codeIndexLog;
    resetCodeIndexAvailabilityForTest();
    server = await startServer(stubHarness(), { criticDrive });
    const ws = (await server.app.ctx.workspaces.list())[0]!;
    workspaceId = ws.id;
    await server.app.ctx.workspaces.update(workspaceId, { workingDir: repoDir });
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
    await server.app.ctx.settingsStore.updateGlobal({ maxAttempts: 2 });
  });
  afterAll(async () => {
    await server.close();
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(codeIndexDir, { recursive: true, force: true });
    if (prevCodeIndexCli === undefined) delete process.env.HARMONIC_CODE_INDEX_CLI;
    else process.env.HARMONIC_CODE_INDEX_CLI = prevCodeIndexCli;
    delete process.env.FAKE_CLI_LOG;
    resetCodeIndexAvailabilityForTest();
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

  let implSeq = 0;
  async function createAndRun(): Promise<{ taskId: number; attemptId: number }> {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { [`critic-feature-${++implSeq}.txt`]: 'work\n' } }),
      workingDir: repoDir,
      isolationMode: 'worktree',
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

  it('AC1/AC2: a passing critic merges a native Run to done; the attempt persists at the verified head OID', async () => {
    criticResult = { verdict: 'pass', summary: 'looks correct' };
    await server.app.ctx.workspaces.update(workspaceId, critic());
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
    expect(rows[0]!).toMatchObject({ mechanism: 'critic', verdict: 'pass', summary: 'looks correct' });
    expect(rows[0]!.inputOid).toMatch(/^[0-9a-f]{40}$/);

    expect(await verdictEvents(attemptId)).toEqual([
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
    const { taskId, attemptId } = await createAndRun();

    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? true : undefined;
    });

    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run.sessionRowId).not.toBe(attemptId);

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
    await server.app.ctx.settingsStore.updateGlobal({
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

  it('issue #428: refreshes the worktree code index to the candidate head before the critic reviews', async () => {
    criticResult = { verdict: 'pass', summary: 'looks correct' };
    await server.app.ctx.workspaces.update(workspaceId, critic());
    const { taskId } = await createAndRun();

    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? true : undefined;
    });

    expect(lastCriticCwd).toBeTruthy();
    expect(lastCriticCwd).not.toBe(repoDir);
    expect(indexCountFor(lastCriticCwd!)).toBe(2);
  });

  it('issue #428: a corrective Attempt re-indexes its own worktree before its critic review', async () => {
    criticResult = { verdict: 'fail', summary: 'not done yet' };
    await server.app.ctx.workspaces.update(workspaceId, critic());
    const { taskId } = await createAndRun();

    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}/attempts/current`);
      return body.state === 'failed' ? body : undefined;
    });
    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).toBe('escalated');

    expect(lastCriticCwd).toBeTruthy();
    expect(indexCountFor(lastCriticCwd!)).toBe(4);
  });
});
