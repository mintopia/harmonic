import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppConfig, baselineConfig, type DeepPartial } from '../src/config.js';
import { type AsyncDbHandle, openAsyncDb } from '../src/db/async.js';
import { apiKeys } from '../src/db/schema.js';
import { AttemptSettleCoordinator } from '../src/domain/attempt-settle.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { TaskService } from '../src/domain/tasks.js';
import { type SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, captureRunEnv, makeSettingsStore, startServer, stubHarness, type TestServer, waitFor } from './helpers.js';
import { eq } from 'drizzle-orm';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('attempt-log', () => {
  describe('GET /api/attempts/:id/log (issue #242)', () => {
    let server: TestServer;
    const workDir = mkdtempSync(join(tmpdir(), 'harmonic-run-log-work-'));
    const logDir = mkdtempSync(join(tmpdir(), 'harmonic-run-log-native-'));
    const sessionId = 'native-log-session';
    const transcriptPath = join(logDir, workDir.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);

    beforeAll(async () => {
      mkdirSync(join(logDir, workDir.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Native assistant output' }] } }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] } }),
          '{ partial line while the harness is flushing',
        ].join('\n'),
      );
      server = await startServer({
        defaults: { workingDir: workDir, isolationMode: 'direct' },
        chat: { harness: 'claude', model: 'stub-model' },
        harnesses: {
          claude: {
            command: process.execPath,
            args: [join(import.meta.dirname, 'stub-harness.mjs')],
            models: ['stub-model'],
            defaultModel: 'stub-model',
            sessionLogDir: logDir,
            env: { STUB_SESSION_ID: sessionId },
          },
        },
      } as DeepPartial<AppConfig>);
    });

    afterAll(async () => {
      await server?.close();
      rmSync(workDir, { recursive: true, force: true });
      rmSync(logDir, { recursive: true, force: true });
    });

    async function startRun(scenario: object): Promise<{ attemptId: number; taskId: number }> {
      const task = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify(scenario),
        workingDir: workDir,
        isolationMode: 'direct',
      });
      const run = await server.api('POST', `/api/tasks/${task.body.id}/run`);
      await waitFor(async () => (await server.app.ctx.attempts.get(run.body.id)).sessionRowId ? true : undefined);
      return { attemptId: run.body.id, taskId: task.body.id };
    }

    it('reads the native transcript for a live Run, not run_events', async () => {
      const { attemptId, taskId } = await startRun({
        updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'database-only output' } }],
        exit: 'hang',
      });

      const { status, body } = await server.api('GET', `/api/attempts/${attemptId}/log`);

      expect(status).toBe(200);
      expect(body.status).toBe('available');
      expect(body.events.map((event: { payload: { content?: { text?: string }; title?: string } }) => event.payload.content?.text ?? event.payload.title)).toEqual([
        'Native assistant output',
        'Read',
      ]);
      expect(JSON.stringify(body)).not.toContain('database-only output');
      await server.api('POST', `/api/tasks/${taskId}/cancel`);
      await waitFor(async () => (await server.app.ctx.attempts.get(attemptId)).endedAt ? true : undefined);
    });

    it('reads the native transcript after a Run finishes', async () => {
      const { attemptId, taskId } = await startRun({ updates: [], delayMs: 1 });
      await waitFor(async () => (await server.app.ctx.attempts.get(attemptId)).state !== 'running' ? true : undefined);

      const { status, body } = await server.api('GET', `/api/attempts/${attemptId}/log`);

      expect(status).toBe(200);
      expect(body.status).toBe('available');
      expect(body.events).toHaveLength(2);
      await server.api('POST', `/api/tasks/${taskId}/cancel`);
    });

    it('reports an unavailable log when the captured transcript disappears', async () => {
      const { attemptId } = await startRun({ updates: [], delayMs: 1 });
      unlinkSync(transcriptPath);

      const { status, body } = await server.api('GET', `/api/attempts/${attemptId}/log`);

      expect(status).toBe(200);
      expect(body).toEqual({ status: 'unavailable', liveCursor: 0 });
    });
  });
});

describe('attempt-keys', () => {
  const attemptKeyRows = (server: TestServer) =>
    server.app.ctx.asyncDb.read((d) => d.select().from(apiKeys).where(eq(apiKeys.scope, 'attempt')).all());

  async function startEchoRun(server: TestServer, exit: 'clean' | 'hang') {
    const { taskId, attemptId, env } = await captureRunEnv(server, ['HARMONIC_API_KEY'], { exit });
    return { taskId, attemptId, token: env.HARMONIC_API_KEY as string };
  }

  describe('attempt key lifecycle (issue 16)', () => {
    let server: TestServer;

    afterEach(async () => {
      await server?.close();
    });

    it('hard-deletes the run key when a run completes, and the token stops authenticating', async () => {
      server = await startServer(stubHarness());
      const { taskId, token } = await startEchoRun(server, 'clean');
      await waitFor(
        async () => (await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done',
      );

      expect(await attemptKeyRows(server)).toEqual([]);
      const res = await fetch(`${server.baseUrl}/api/tasks`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(401);
    });

    it('hard-deletes the run key when a run is cancelled', async () => {
      server = await startServer(stubHarness());
      const { taskId } = await startEchoRun(server, 'hang');
      expect((await attemptKeyRows(server)).length).toBe(1);

      await server.api('POST', `/api/tasks/${taskId}/cancel`);
      await waitFor(async () => (await attemptKeyRows(server)).length === 0 || undefined);
    });

    it('hard-deletes the run key when a run escalates', async () => {
      server = await startServer({ ...stubHarness(), maxAttempts: 1 });
      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ exit: 'crash-before-response' }),
      });
      await server.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(
        async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated',
      );
      expect(await attemptKeyRows(server)).toEqual([]);
    });

    it('hard-deletes the run key when the harness fails to even spawn', async () => {
      server = await startServer({ ...stubHarness(), maxAttempts: 1 });
      await server.api('PATCH', '/api/config', { harnesses: { claude: { command: '' } } });
      const created = await server.api('POST', '/api/tasks', { prompt: 'never runs' });
      await server.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(
        async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated',
      );
      expect(await attemptKeyRows(server)).toEqual([]);
    });

    it('startup sweep deletes orphaned run keys, not operator keys', async () => {
      server = await startServer(stubHarness());
      const orphan = await server.app.ctx.auth.createKey('run-999', { scope: 'attempt', attemptId: 999 });
      const operator = await server.api('POST', '/api/keys', { name: 'ops' });

      const dataDir = server.dataDir;
      await server.app.close();
      server = await startServer(stubHarness(), { dataDir });

      expect(await attemptKeyRows(server)).toEqual([]);
      const orphanRes = await fetch(`${server.baseUrl}/api/tasks`, {
        headers: { authorization: `Bearer ${orphan.token}` },
      });
      expect(orphanRes.status).toBe(401);

      const opRes = await fetch(`${server.baseUrl}/api/tasks`, {
        headers: { authorization: `Bearer ${operator.body.token}` },
      });
      expect(opRes.status).toBe(200);
    });

    it('never lists Attempt Keys, even while the run is active', async () => {
      server = await startServer(stubHarness());
      await server.api('POST', '/api/keys', { name: 'ops' });
      const { taskId } = await startEchoRun(server, 'hang');
      expect((await attemptKeyRows(server)).length).toBe(1);

      const { body } = await server.api('GET', '/api/keys');
      expect(body.keys.map((k: any) => k.name)).toEqual(['ops']);
      expect(body.keys.every((k: any) => k.scope === 'full')).toBe(true);

      await server.api('POST', `/api/tasks/${taskId}/cancel`);
    });
  });
});

describe('attempt-settle', () => {
  describe('AttemptSettleCoordinator.settle — guarded state transition', () => {
    let dir: string;
    let asyncDb: AsyncDbHandle;
    let settingsStore: SettingsStore;
    let tasks: TaskService;
    let attempts: AttemptStore;
    let settle: AttemptSettleCoordinator;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'harmonic-run-settle-'));
      asyncDb = await openAsyncDb(dir);
      settingsStore = await makeSettingsStore(dir);
      tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
      attempts = new AttemptStore(asyncDb);
      settle = new AttemptSettleCoordinator(tasks, attempts);
    });
    afterEach(async () => {
      await asyncDb.close();
      rmSync(dir, { recursive: true, force: true });
    });

    async function runningTask() {
      const task = await tasks.create({ prompt: 'p', state: 'ready' });
      await tasks.setState(task.id, 'working');
      const run = await attempts.create(task.id);
      return { task: await tasks.get(task.id), run };
    }

    it('(i) the first ending signal wins on a running Attempt, and writes attempts.reason to the ending kind', async () => {
      const { task, run } = await runningTask();

      await settle.settle(task, run, 'failed', { runState: 'failed', taskAction: 'ready', reason: 'boom' });

      const attempt = await attempts.get(run.id);
      expect(attempt).toMatchObject({ state: 'failed', reason: 'failed' });
      expect((await tasks.get(task.id)).state).toBe('ready');
    });

    it('(iii) a second racing settle on an already-terminal Attempt is a no-op', async () => {
      const { task, run } = await runningTask();
      await settle.settle(task, run, 'failed', { runState: 'failed', taskAction: 'ready', reason: 'boom' });
      const settledAttempt = await attempts.get(run.id);

      await settle.settle(await tasks.get(task.id), run, 'escalate', {
        runState: 'failed',
        taskAction: 'escalate',
        reason: 'escalated to human: too late',
      });

      expect(await attempts.get(run.id)).toEqual(settledAttempt);
      expect((await tasks.get(task.id)).state).toBe('ready');
    });

    it('(ii) operator-accept overrides an already-escalated Attempt, moving it to passed', async () => {
      const { task, run } = await runningTask();
      await settle.settle(task, run, 'escalate', {
        runState: 'failed',
        taskAction: 'escalate',
        reason: 'escalated to human: attempt 1 of 1 failed',
      });
      expect((await tasks.get(task.id)).state).toBe('escalated');
      const escalatedAttempt = await attempts.get(run.id);
      expect(escalatedAttempt).toMatchObject({ state: 'escalated', reason: 'escalate' });

      await settle.settle(await tasks.get(task.id), await attempts.get(run.id), 'operator-accept', {
        runState: 'completed',
        taskAction: 'done',
        reason: null,
      });

      const acceptedAttempt = await attempts.get(run.id);
      expect(acceptedAttempt).toMatchObject({ state: 'passed', reason: 'operator-accept' });
      expect((await tasks.get(task.id)).state).toBe('done');
    });

    it('(ii) operator-cancel overrides an already-escalated Attempt, moving it to cancelled', async () => {
      const { task, run } = await runningTask();
      await settle.settle(task, run, 'escalate', {
        runState: 'failed',
        taskAction: 'escalate',
        reason: 'escalated to human: attempt 1 of 1 failed',
      });

      await settle.settle(await tasks.get(task.id), await attempts.get(run.id), 'operator-cancel', {
        runState: 'cancelled',
        taskAction: 'none',
        reason: null,
      });

      const cancelledAttempt = await attempts.get(run.id);
      expect(cancelledAttempt).toMatchObject({ state: 'cancelled', reason: 'operator-cancel' });
    });

    it('(iv) attempts.reason records the ending kind across every disposition, not free-text detail', async () => {
      const { task, run } = await runningTask();
      await settle.settle(task, run, 'guardrail-trip', {
        runState: 'failed',
        taskAction: 'escalate',
        reason: 'escalated to human: wall-clock budget exceeded',
      });
      const attempt = await attempts.get(run.id);
      expect(attempt).toMatchObject({ state: 'escalated', reason: 'guardrail-trip' });
      expect((await tasks.get(task.id)).escalationReason).toBe('escalated to human: wall-clock budget exceeded');
    });
  });
});

describe('attempt-timeline-route', () => {
  describe('attempt timeline API', () => {
    let server: TestServer;

    beforeEach(async () => {
      server = await startServer(stubHarness());
    });

    afterEach(async () => {
      await server.close();
    });

    it('serves the same ordered timeline over REST and WebSocket', async () => {
      const messages: unknown[] = [];
      const socket = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/ws?token=${server.sessionToken}`);
      socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve());
        socket.addEventListener('error', reject);
      });

      const created = await server.api('POST', '/api/tasks', { prompt: 'timeline parity' });
      const attempt = await server.app.ctx.attempts.ensureForRun(created.body.id, 1, 10);
      const implementation = await server.app.ctx.attempts.createStep(attempt.id, {
        type: 'implementation',
        logLocator: 'transcript:/tmp/session.jsonl',
      });
      await server.app.ctx.attempts.updateStep(implementation.id, {
        state: 'passed',
        verdict: 'pass',
        startedAt: 11,
        endedAt: 12,
      });
      await server.app.ctx.attempts.setContinuation(attempt.id, {
        path: 'new-session-condensed',
        reason: 'context-tokens',
        contextTokens: 250_000,
        contextReuseTokenLimit: 200_000,
        lastActiveAt: 9,
        lastActiveAgeMs: 1,
        warmWindowMs: 60 * 60 * 1000,
      });
      const verification = await server.app.ctx.attempts.createStep(attempt.id, {
        type: 'verification',
        command: 'npm test',
        logLocator: 'verification_attempt:31',
      });
      await server.app.ctx.attempts.updateStep(verification.id, {
        state: 'passed',
        verdict: 'pass',
        startedAt: 13,
        endedAt: 14,
      });
      const run = await server.app.ctx.attempts.create(created.body.id);
      await server.app.ctx.verificationAttempts.append(attempt.id, {
        mechanism: 'command', inputOid: 'verified-sha', verdict: 'pass', summary: 'checks passed', output: '',
      });
      await server.app.ctx.attempts.finish(attempt.id, 'escalated', 15, undefined, 'escalate');
      server.app.ctx.bus.emit('attempt_changed', run);
      await waitFor(async () => messages.find(
        (message) => typeof message === 'object'
          && message !== null
          && Reflect.get(message, 'type') === 'attempt_timeline_changed'
          && Reflect.get(message, 'taskId') === created.body.id,
      ));

      const event = messages.find(
        (message) => typeof message === 'object'
          && message !== null
          && Reflect.get(message, 'type') === 'attempt_timeline_changed'
          && Reflect.get(message, 'taskId') === created.body.id,
      );
      const rest = await server.api('GET', `/api/tasks/${created.body.id}/attempts/timeline`);

      expect(rest.status).toBe(200);
      expect(Reflect.get(event!, 'attempts')).toEqual(rest.body.attempts);
      expect(rest.body.attempts[0].steps.map((step: { position: number }) => step.position)).toEqual([1, 2]);
      expect(rest.body.attempts[0].verifiedSha).toBe('verified-sha');
      expect(rest.body.attempts[0].escalationReason).toBe('escalate');
      expect(rest.body.attempts[0].continuation).toMatchObject({ path: 'new-session-condensed', contextTokens: 250_000 });
      expect(rest.body.attempts[0].verifierStatuses).toEqual([
        { mechanism: 'command', state: 'passed', reason: null },
        { mechanism: 'critic', state: 'disabled', reason: 'Critic verification is disabled.' },
      ]);
      expect(rest.body.attempts[0].steps[1]).not.toHaveProperty('verifiedSha');
      socket.close();
    });

    it('broadcasts the timeline when a Step transitions mid-Attempt', async () => {
      const messages: unknown[] = [];
      const socket = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/ws?token=${server.sessionToken}`);
      socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve());
        socket.addEventListener('error', reject);
      });

      const created = await server.api('POST', '/api/tasks', { prompt: 'live phase' });
      const attempt = await server.app.ctx.attempts.ensureForRun(created.body.id, 1, 10);
      const verification = await server.app.ctx.attempts.createStep(attempt.id, { type: 'verification', command: 'npm test' });
      await server.app.ctx.attempts.updateStep(verification.id, { state: 'running', startedAt: 11 });

      // The Attempt row never changes when Implementation gives way to Verify, so
      // only `step_changed` can carry the live phase to the Task-detail timeline.
      server.app.ctx.bus.emit('step_changed', { taskId: created.body.id });

      const message = await waitFor(async () => messages.find(
        (m) => typeof m === 'object' && m !== null
          && Reflect.get(m, 'type') === 'attempt_timeline_changed'
          && Reflect.get(m, 'taskId') === created.body.id,
      ));
      const steps = (Reflect.get(message!, 'attempts') as { steps: { type: string; state: string }[] }[])[0]!.steps;
      expect(steps).toEqual([{ ...steps[0], type: 'verification', state: 'running' }]);
      socket.close();
    });
  });
});
