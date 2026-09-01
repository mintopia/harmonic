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

const markerCommand = (want: string): VerificationCommand =>
  verificationCommandSchema.parse({
    command: process.execPath,
    args: [
      '-e',
      `let v='';try{v=require('fs').readFileSync('marker.txt','utf8').trim()}catch{};process.exit(v===${JSON.stringify(want)}?0:1)`,
    ],
    timeoutSeconds: 30,
  });

const alwaysFail = (): VerificationCommand =>
  verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutSeconds: 30 });

const inconclusiveCommand = (): VerificationCommand =>
  verificationCommandSchema.parse({ command: join(tmpdir(), 'harmonic-no-such-verify-binary-xyz'), args: [], timeoutSeconds: 30 });

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
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: null,
      maxAttempts: null,
    });
    await server.app.ctx.settingsStore.updateGlobal({ maxAttempts: 2 });
  });

  const attempts = async (attemptId: number) => {
    const store = new VerificationAttemptStore(server.app.ctx.asyncDb);
    const run = await server.app.ctx.attempts.get(attemptId);
    const taskAttempts = await server.app.ctx.attempts.listForTask(run.taskId);
    return (await Promise.all(taskAttempts.map((a) => store.list(a.id)))).flat();
  };
  const ticketAttempts = (taskId: number) => new AttemptStore(server.app.ctx.asyncDb).listForTask(taskId);

  async function runWorktreeTask(prompt: unknown): Promise<{ taskId: number; attemptId: number }> {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify(prompt),
      workingDir: repoDir,
      isolationMode: 'worktree',
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    return { taskId: created.body.id, attemptId: started.body.id };
  }

  it('AC1/AC2: an actionable fail creates Attempt N+1 with feedback and re-verifies', async () => {
    await server.app.ctx.workspaces.update(workspaceId, {
      verificationCommand: [markerCommand('ok')],
    });
    const baseOidBefore = git(repoDir, 'rev-parse', 'main');

    const { taskId, attemptId } = await runWorktreeTask({
      turns: [{ writeFiles: { 'marker.txt': 'bad\n' } }, { writeFiles: { 'marker.txt': 'ok\n' } }],
    });

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');

    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run.state).toBe('completed');

    const baseOidAfter = git(repoDir, 'rev-parse', 'main');
    expect(baseOidAfter).not.toBe(baseOidBefore);
    expect(git(repoDir, 'show', `${baseOidAfter}:marker.txt`)).toBe('ok');

    const rows = await attempts(attemptId);
    expect(rows.map((r) => r.verdict)).toEqual(['fail', 'pass', 'pass']);
    expect(rows[0]!.inputOid).not.toBe(rows[1]!.inputOid);

    const attemptsByTicket = await ticketAttempts(taskId);
    expect(attemptsByTicket).toMatchObject([
      { number: 1, state: 'failed' },
      { number: 2, state: 'passed' },
    ]);
    expect(attemptsByTicket[0]!.feedback).toContain('verifier command failed');

    const stepTypesByAttempt = await Promise.all(
      attemptsByTicket.map(async (a) => (await server.app.ctx.attempts.listSteps(a.id)).map((s) => s.type)),
    );
    expect(stepTypesByAttempt).toEqual([
      ['rebase', 'implementation', 'verification'],
      ['rebase', 'implementation', 'verification'],
    ]);
  });

  async function implementationSession(attemptId: number) {
    const steps = await new AttemptStore(server.app.ctx.asyncDb).listSteps(attemptId);
    const locator = steps.find((step) => step.type === 'implementation')?.logLocator ?? '';
    const match = /^session:(\d+)$/.exec(locator);
    expect(match, `implementation locator ${locator}`).not.toBeNull();
    return server.app.ctx.sessions.get(Number(match![1]));
  }

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

    const { taskId, attemptId } = await runWorktreeTask({ writeFiles: { 'marker.txt': 'anything\n' } });

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'escalated' ? body : undefined;
    });
    expect(task.state).toBe('escalated');

    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run.state).toBe('failed');

    const rows = await attempts(attemptId);
    expect(rows.map((row) => row.verdict)).toEqual(['inconclusive', 'inconclusive']);
    expect(await ticketAttempts(taskId)).toMatchObject([
      { number: 1, state: 'failed' },
      { number: 2, state: 'escalated' },
    ]);
  });

  it('AC3: an actionable fail exhausts maxAttempts and escalates', async () => {
    await server.app.ctx.workspaces.update(workspaceId, { verificationCommand: [alwaysFail()] });
    await server.app.ctx.settingsStore.updateGlobal({ maxAttempts: 2 });

    const { taskId, attemptId } = await runWorktreeTask({ writeFiles: { 'marker.txt': 'bad\n' } });

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}/attempts/current`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).toBe('escalated');

    const rows = await attempts(attemptId);
    expect(rows.map((r) => r.verdict)).toEqual(['fail', 'fail']);
    expect(await ticketAttempts(taskId)).toMatchObject([
      { number: 1, state: 'failed' },
      { number: 2, state: 'escalated' },
    ]);
  });

  it('a workspace maxAttempts override escalates after its first failed attempt', async () => {
    await server.app.ctx.workspaces.update(workspaceId, { verificationCommand: [alwaysFail()] });
    await server.app.ctx.settingsStore.updateGlobal({ maxAttempts: 3 });
    await server.app.ctx.workspaces.update(workspaceId, { maxAttempts: 1 });

    const { taskId, attemptId } = await runWorktreeTask({ writeFiles: { 'marker.txt': 'bad\n' } });

    const run = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}/attempts/current`);
      return body.state === 'failed' ? body : undefined;
    });
    expect(run.state).toBe('failed');

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.state).toBe('escalated');

    expect((await attempts(attemptId)).map((r) => r.verdict)).toEqual(['fail']);
    expect(await ticketAttempts(taskId)).toMatchObject([{ number: 1, state: 'escalated' }]);
  });
});
