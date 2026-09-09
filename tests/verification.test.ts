import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type HarnessId, type VerificationCommand, verificationCommandSchema } from '../src/config.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import { resetCodeIndexAvailabilityForTest } from '../src/execution/code-index.js';
import { type Verdict } from '../src/verification/critic-schema.js';
import { type CriticHarnessDrive } from '../src/verification/critic.js';
import { startServer, stubHarness, type TestServer, waitFor } from './helpers.js';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('verification-attempts-route', () => {
  describe('GET /api/attempts/:id/verification-attempts (issue #169)', () => {
    let server: TestServer;
    const ctx = () => server.app.ctx;

    beforeEach(async () => {
      server = await startServer(stubHarness());
    });
    afterEach(async () => {
      await server.close();
    });

    it("lists a run's verification attempts in seq order", async () => {
      const created = await server.api('POST', '/api/tasks', { prompt: 'verification target' });
      const task = await ctx().tasks.get(created.body.id);
      const run = await ctx().attempts.create(task.id);
      const attempt = run;

      await ctx().verificationAttempts.append(attempt.id, {
        mechanism: 'command',
        inputOid: 'oid1',
        verdict: 'pass',
        summary: 'ok',
        output: '',
      });
      await ctx().verificationAttempts.append(attempt.id, {
        mechanism: 'critic',
        inputOid: 'oid2',
        verdict: 'fail',
        summary: 'nope',
        output: 'details',
      });

      const res = await server.api('GET', `/api/attempts/${run.id}/verification-attempts`);
      expect(res.status).toBe(200);
      expect(res.body.verificationAttempts).toHaveLength(2);
      expect(res.body.verificationAttempts[0]).toMatchObject({
        attemptId: attempt.id,
        seq: 1,
        mechanism: 'command',
        inputOid: 'oid1',
        verdict: 'pass',
        summary: 'ok',
        output: '',
      });
      expect(res.body.verificationAttempts[1]).toMatchObject({
        attemptId: attempt.id,
        seq: 2,
        mechanism: 'critic',
        inputOid: 'oid2',
        verdict: 'fail',
        summary: 'nope',
        output: 'details',
      });
      expect(res.body.verifierStatuses).toEqual(expect.arrayContaining([
        { mechanism: 'command', state: 'passed', reason: null },
        { mechanism: 'critic', state: 'failed', reason: null },
      ]));
    });

    it('reconciles recorded attempts with configured verifier statuses', async () => {
      const configured = await startServer({
        ...stubHarness(),
        verify: { task: { preMerge: { commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }], critics: [{ prompt: 'Review the diff.', model: 'stub-model' }] } } },
      });
      try {
        const created = await configured.api('POST', '/api/tasks', { prompt: 'verification status target' });
        const task = await configured.app.ctx.tasks.get(created.body.id);
        const run = await configured.app.ctx.attempts.create(task.id);
        const attempt = run;
        await configured.app.ctx.verificationAttempts.append(attempt.id, {
          mechanism: 'critic',
          inputOid: 'oid1',
          verdict: 'pass',
          summary: 'looks good',
          output: '',
          });

        const res = await configured.api('GET', `/api/attempts/${run.id}/verification-attempts`);

        expect(res.status).toBe(200);
        expect(res.body.verifierStatuses).toEqual([
          { mechanism: 'command', state: 'skipped', reason: 'No command verification attempt was recorded for this attempt.', commands: ['npm test'] },
          { mechanism: 'critic', state: 'passed', reason: null },
        ]);
      } finally {
        await configured.close();
      }
    });

    it('reconciles recorded attempts with configured verifier statuses', async () => {
      const configured = await startServer({
        ...stubHarness(),
        verify: { task: { preMerge: { commands: [{ command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }], critics: [{ prompt: 'Review the diff.', model: 'stub-model' }] } } },
      });
      try {
        const created = await configured.api('POST', '/api/tasks', { prompt: 'verification status target' });
        const task = await configured.app.ctx.tasks.get(created.body.id);
        const run = await configured.app.ctx.attempts.create(task.id);
        const attempt = run;
        await configured.app.ctx.verificationAttempts.append(attempt.id, {
          mechanism: 'critic',
          inputOid: 'oid1',
          verdict: 'pass',
          summary: 'looks good',
          output: '',
          });

        const res = await configured.api('GET', `/api/attempts/${run.id}/verification-attempts`);

        expect(res.status).toBe(200);
        expect(res.body.verifierStatuses).toEqual([
          { mechanism: 'command', state: 'skipped', reason: 'No command verification attempt was recorded for this attempt.', commands: ['npm test'] },
          { mechanism: 'critic', state: 'passed', reason: null },
        ]);
      } finally {
        await configured.close();
      }
    });

    it('404s for an unknown run', async () => {
      const res = await server.api('GET', '/api/attempts/999999/verification-attempts');
      expect(res.status).toBe(404);
    });
  });
});

describe('verification-selfheal', () => {
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
        taskPreMergeCommands: null,
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
        taskPreMergeCommands: [markerCommand('ok')],
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
      expect(rows.map((r) => r.verdict)).toEqual(['fail', 'pass']);
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
        taskPreMergeCommands: [markerCommand('ok')],
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
      await server.app.ctx.workspaces.update(workspaceId, { taskPreMergeCommands: [inconclusiveCommand()] });

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
      await server.app.ctx.workspaces.update(workspaceId, { taskPreMergeCommands: [alwaysFail()] });
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
      await server.app.ctx.workspaces.update(workspaceId, { taskPreMergeCommands: [alwaysFail()] });
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
});

describe('verification-critic', () => {
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

  const critic = () => ({ taskPreMergeCritics: [{ prompt: 'Review the diff for correctness.', model: 'stub-model' }] });

  const criticWithHarness = (harness: HarnessId) => ({ taskPreMergeCritics: [{ prompt: 'Review the diff for correctness.', model: 'stub-model', harness }] });

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
        req.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reviewing the change' } });
        req.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'read', title: 'Read src/config.ts', status: 'completed' });
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
        taskPreMergeCommands: null,
        taskPreMergeCritics: null,
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

      // The critic's ACP updates stream on their own channel (keyed by the builder
      // Attempt), verbatim and structured, so the running critic renders as a chat.
      const criticLog = [...server.app.ctx.bus.replayCriticLog({ attemptId, after: 0 })];
      expect(criticLog.map((e) => e.payload)).toEqual([
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reviewing the change' } },
        { sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'read', title: 'Read src/config.ts', status: 'completed' },
      ]);
      // ...and never leak into the builder's Implementation transcript stream.
      expect([...server.app.ctx.bus.replayAttemptLog({ attemptId, after: 0 })].some((e) => e.payload.sessionUpdate === 'tool_call' && e.payload.toolCallId === 'c1')).toBe(false);
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
        taskPreMergeCommands: [exitCommand(0)],
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
        taskPreMergeCommands: [exitCommand(0)],
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
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => `${r.mechanism}:${r.verdict}`).sort()).toEqual(['command:pass', 'critic:pass']);
    });

    it('records implementation, verification, and review outcomes in the Attempt timeline', async () => {
      criticResult = { verdict: 'pass', summary: 'correct and complete' };
      const command = exitCommand(0);
      await server.app.ctx.workspaces.update(workspaceId, {
        taskPreMergeCommands: [command],
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
          codex: {
            command: process.execPath,
            args: [],
            models: [{ id: 'stub-model' }],
            defaultModel: 'stub-model',
            cacheWarmSeconds: 300,
          },
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
});

describe('verification-command', () => {
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
      await server.app.ctx.workspaces.update(workspaceId, { taskPreMergeCommands: [exitCommand(0)] });
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
        taskPreMergeCommands: [exitCommand(0)],
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
        taskPreMergeCommands: [exitCommand(0)],
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
      await server.app.ctx.workspaces.update(workspaceId, { taskPreMergeCommands: [exitCommand(1)] });
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
        taskPreMergeCommands: [
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
        taskPreMergeCommands: [exitCommand(0)],
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
        taskPreMergeCommands: null,
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
        taskPreMergeCommands: [exitCommand(0)],
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
        taskPreMergeCommands: [exitCommand(0)],
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
        taskPreMergeCommands: [echoExit('CMD1', 0), echoExit('CMD2', 1), echoExit('CMD3', 0)],
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
        taskPreMergeCommands: [exitCommand(0)],
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
        taskPreMergeCommands: [exitCommand(0)],
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
        taskPreMergeCommands: [exitCommand(1)],
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
        taskPreMergeCommands: null,
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
        taskPreMergeCommands: [exitCommand(0)],
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
});
