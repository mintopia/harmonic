// Merged ticket suite (timeline route + closed-while-working). The web-component ticket files
// stay separate (jsdom loader). Consolidated so the isolated-pool import graph is paid once.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baselineConfig } from '../src/config.js';
import { type AsyncDbHandle, openAsyncDb } from '../src/db/async.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { type MirrorInput, TaskService } from '../src/domain/tasks.js';
import { type SettingsStore } from '../src/server/settings-store.js';
import { type Ticket, type TrackerAdapter } from '../src/tracker/adapter.js';
import { mirrorScan } from '../src/tracker/mirror.js';
import { TrackerPoller } from '../src/tracker/poller.js';
import { allWorkspaces, makeSettingsStore, startServer, stubHarness, type TestServer } from './helpers.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ===== ticket-timeline-route.test.ts =====
{
  describe('GET /api/tasks/:id/timeline (issue #328)', () => {
    let server: TestServer;

    beforeEach(async () => {
      server = await startServer(stubHarness());
    });

    afterEach(async () => {
      await server.close();
    });

    it('folds all persisted ticket events into chronological order', async () => {
      const task = await server.api('POST', '/api/tasks', { prompt: 'timeline target' });
      const attempt = await server.app.ctx.attempts.create(task.body.id);
      const skipped = await server.app.ctx.attempts.createStep(attempt.id, { type: 'verification', command: 'npm test' });
      await server.app.ctx.attempts.updateStep(skipped.id, { state: 'skipped', endedAt: 400 });
      await server.app.ctx.attempts.finish(attempt.id, 'passed', 850);
      await server.app.ctx.attempts.update(attempt.id, { startedAt: 100, endedAt: 900 });
      await server.app.ctx.attempts.appendEvent(attempt.id, { type: 'lifecycle', payload: { event: 'progress-nudge', pattern: 'monologue' } });
      await server.app.ctx.attempts.appendEvent(attempt.id, { type: 'permission_request', payload: { reason: 'outside the timeline' } });
      await server.app.ctx.verificationAttempts.append(attempt.id, {
        mechanism: 'command', inputOid: 'abc123', verdict: 'pass', summary: 'checks passed', output: '',
      }, 200);
      await server.app.ctx.guardrailEvents.append(attempt.id, {
        dimension: 'wall-clock', limitValue: 60_000, observedValue: 60_001, configSource: 'default',
      }, 250);
      const otherTask = await server.api('POST', '/api/tasks', { prompt: 'another timeline' });
      const otherAttempt = await server.app.ctx.attempts.create(otherTask.body.id);
      await server.app.ctx.attempts.appendEvent(otherAttempt.id, { type: 'lifecycle', payload: { event: 'unrelated' } });

      const response = await server.api('GET', `/api/tasks/${task.body.id}/timeline`);

      expect(response.status).toBe(200);
      expect(response.body.events.map((event: { kind: string }) => event.kind)).toEqual([
        'attempt-started', 'verification', 'guardrail', 'verification', 'verification', 'attempt-finished', 'fact', 'lifecycle',
      ]);
      expect(response.body.events.map((event: { ts: number }) => event.ts)).toEqual([100, 200, 250, 400, 900, 900, expect.any(Number), expect.any(Number)]);
      expect(response.body.events.find((event: { kind: string }) => event.kind === 'fact')).toMatchObject({ data: { type: 'task-created' } });
      expect(response.body.events.every((event: { attemptId: number | null }) => event.attemptId === null || event.attemptId === attempt.id)).toBe(true);
      expect(response.body.events.find((event: { kind: string }) => event.kind === 'verification')).toMatchObject({ data: {
        verdict: 'pass', summary: 'checks passed', mechanism: 'command',
      } });
      expect(response.body.events.find((event: { data: { outcome?: string } }) => event.data.outcome === 'skipped')).toMatchObject({ data: { outcome: 'skipped' } });
      expect(response.body.events.filter((event: { data: { outcome?: string } }) => event.data.outcome === 'disabled')).toHaveLength(1);
      expect(response.body.events.filter((event: { kind: string }) => event.kind === 'lifecycle')).toMatchObject([
        { data: { type: 'lifecycle', payload: { event: 'progress-nudge', pattern: 'monologue' } } },
      ]);
      const finished = response.body.events.find((event: { kind: string }) => event.kind === 'attempt-finished');
      expect(finished).toMatchObject({ data: { attempt: 1, state: 'passed', feedback: null, reason: null } });
    });

    it('derives Reject with guidance from adjacent attempts without misreporting Close as Reject', async () => {
      const task = await server.api('POST', '/api/tasks', { prompt: 'disposition target' });
      const escalated = await server.app.ctx.attempts.ensureForRun(task.body.id, 1, 100);
      await server.app.ctx.attempts.finish(escalated.id, 'escalated', 150, undefined, 'escalate');
      await server.app.ctx.attempts.setFeedback(escalated.id, 'Use the documented timeout.');
      await server.app.ctx.attempts.ensureForRun(task.body.id, 2, 200);

      const response = await server.api('GET', `/api/tasks/${task.body.id}/timeline`);

      expect(response.status).toBe(200);
      expect(response.body.events).toContainEqual(expect.objectContaining({
        kind: 'operator-reject',
        ts: 200,
        data: { attempt: 1, feedback: 'Use the documented timeout.' },
      }));
      expect(response.body.events).toContainEqual(expect.objectContaining({
        kind: 'attempt-finished',
        ts: 150,
        data: { attempt: 1, state: 'escalated', feedback: 'Use the documented timeout.', reason: 'escalate' },
      }));
      expect(response.body.events.filter((event: { kind: string }) => event.kind === 'operator-reject')).toHaveLength(1);
    });

    it('shows only the task-created row for a task with no runs, and 404 for an unknown task', async () => {
      const task = await server.api('POST', '/api/tasks', { prompt: 'empty timeline' });

      await expect(server.api('GET', `/api/tasks/${task.body.id}/timeline`)).resolves.toMatchObject({
        status: 200,
        body: { events: [{ kind: 'fact', data: { type: 'task-created' } }] },
      });
      await expect(server.api('GET', '/api/tasks/999999/timeline')).resolves.toMatchObject({ status: 404 });
    });
  });
}

// ===== ticket-closed-while-working.test.ts =====
{
  const mirrored = (ref: number, over: Partial<MirrorInput> = {}): MirrorInput => ({
    trackerRef: ref,
    prompt: `ticket ${ref}\n\nbody`,
    workflow: 'implement',
    wayfinderType: null,
    mapRef: null,
    closed: false,
    ...over,
  });

  const ticket = (over: Partial<Ticket>): Ticket => ({
    number: 7,
    title: 'A ticket',
    state: 'open',
    body: '',
    createdAt: '2026-08-07T00:00:00Z',
    closedAt: null,
    labels: ['ready-for-agent'],
    assignees: [],
    parent: null,
    blockedBy: [],
    blocking: [],
    comments: [],
    isMap: false,
    url: 'https://x/7',
    ...over,
  });

  function writeSpy(tickets: () => Ticket[]) {
    const calls = { reopen: [] as number[], close: [] as number[], claim: [] as number[], release: [] as number[] };
    const adapter: TrackerAdapter = {
      name: 'fake',
      scan: async () => tickets(),
      readTicket: async (ref) => tickets().find((t) => t.number === ref.number) ?? ticket({ number: ref.number }),
      claim: async (t) => {
        calls.claim.push(t.number);
      },
      release: async (t) => {
        calls.release.push(t.number);
      },
      close: async (t) => {
        calls.close.push(t.number);
      },
      reopen: async (t) => {
        calls.reopen.push(t.number);
      },
    };
    return { adapter, calls };
  }

  describe('a mirrored ticket closed while its Task is working', () => {
    let dir: string;
    let asyncDb: AsyncDbHandle;
    let settingsStore: SettingsStore;
    let tasks: TaskService;
    let runs: AttemptStore;
    let wsId: number;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'harmonic-closed-working-'));
      asyncDb = await openAsyncDb(dir);
      settingsStore = await makeSettingsStore(dir);
      tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
      runs = new AttemptStore(asyncDb);
      wsId = (await allWorkspaces(asyncDb, settingsStore)())[0]!.id;
    });
    afterEach(async () => {
      await asyncDb.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('the poll leaves the working Task alone and writes nothing back to the tracker', async () => {
      let current = [ticket({ number: 7 })];
      const { adapter, calls } = writeSpy(() => current);
      const poller = new TrackerPoller(tasks, wsId, dir, 60_000, async () => adapter);
      await poller.poll();
      const task = (await tasks.list())[0]!;
      await tasks.setState(task.id, 'working');
      await runs.create(task.id);

      current = [ticket({ number: 7, state: 'closed', closedAt: '2026-08-07T01:00:00Z' })];
      await poller.poll();

      expect((await tasks.get(task.id)).state).toBe('working');
      expect(calls.reopen).toEqual([]);
      expect(calls.close).toEqual([]);
      expect(calls.release).toEqual([]);
    });

    it('does not complete, so a premature close leaves dependents not agent-workable', async () => {
      const blocker = await tasks.upsertMirrored(mirrored(1));
      const dependent = await tasks.create({ prompt: 'dependent', state: 'ready' });
      await tasks.addDependency(dependent.id, blocker.id);
      expect((await tasks.withDeps(await tasks.get(dependent.id))).openBlockerCount).toBe(1);
      expect((await tasks.withDeps(await tasks.get(dependent.id))).agentWorkable).toBe(false);
      await tasks.setState(blocker.id, 'working');

      await mirrorScan(tasks, [ticket({ number: 1, state: 'closed', closedAt: '2026-08-07T01:00:00Z' })], wsId);

      expect((await tasks.get(blocker.id)).state).toBe('working');
      expect((await tasks.withDeps(await tasks.get(dependent.id))).openBlockerCount).toBe(1);
      expect((await tasks.withDeps(await tasks.get(dependent.id))).agentWorkable).toBe(false);
    });

    it('a resting Task whose ticket closed is mirrored done, and its dependents unblock', async () => {
      const blocker = await tasks.upsertMirrored(mirrored(1));
      const dependent = await tasks.create({ prompt: 'dependent', state: 'ready' });
      await tasks.addDependency(dependent.id, blocker.id);

      await mirrorScan(tasks, [ticket({ number: 1, state: 'closed', closedAt: '2026-08-07T01:00:00Z' })], wsId);

      expect((await tasks.get(blocker.id)).state).toBe('done');
      expect((await tasks.withDeps(await tasks.get(dependent.id))).openBlockerCount).toBe(0);
      expect((await tasks.withDeps(await tasks.get(dependent.id))).agentWorkable).toBe(true);
    });

    it('an escalated Task whose ticket closed stays escalated — the human decision is Harmonic\'s own fact', async () => {
      const task = await tasks.upsertMirrored(mirrored(9));
      await tasks.escalate(task.id, 'escalated to human: attempt 2 of 2 failed');

      await mirrorScan(tasks, [ticket({ number: 9, state: 'closed', closedAt: '2026-08-07T01:00:00Z' })], wsId);

      expect(await tasks.get(task.id)).toMatchObject({ state: 'escalated', escalationReason: 'escalated to human: attempt 2 of 2 failed' });
    });
  });
}
