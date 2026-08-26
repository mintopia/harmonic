import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { SessionStore } from '../src/domain/sessions.js';
import { RunFactStore } from '../src/domain/run-facts.js';
import { TurnQueueStore } from '../src/domain/turn-queue-store.js';
import {
  BootResumeCoordinator,
  CRASH_RECOVERY_PROMPT,
  type ResumeCapabilities,
} from '../src/domain/boot-resume-coordinator.js';
import type { RunRow, SessionRow } from '../src/db/schema.js';
import { allWorkspaces } from './helpers.js';
import type { YieldOptions } from '../src/reliability/yield.js';
import { yieldToEventLoop } from '../src/reliability/yield.js';

/**
 * Direct unit coverage for `BootResumeCoordinator` (issue #146, reliability-design
 * Unit C) over a real temp sqlite DB — the same store-construction idiom as
 * crash-recovery.test.ts. It seeds an interrupted, Session-bound Run exactly as
 * the boot orphan-fail sweep leaves one (`state:'failed'`, `reason:'interrupted'`,
 * `sessionRowId` set) and asserts the resume disposition per compatibility axis;
 * boot-recovery.test.ts covers the same through the full server boot path.
 */
describe('BootResumeCoordinator (issue #146)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let runStore: RunStore;
  let attemptStore: AttemptStore;
  let sessions: SessionStore;
  let runFacts: RunFactStore;
  let turnQueue: TurnQueueStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-boot-resume-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
    runStore = new RunStore(asyncDb);
    attemptStore = new AttemptStore(asyncDb);
    sessions = new SessionStore(asyncDb);
    runFacts = new RunFactStore(asyncDb);
    turnQueue = new TurnQueueStore(asyncDb);
  });

  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** An interrupted Run bound to a durable Session, exactly as the boot
   * orphan-fail sweep (`RunStore.markInterrupted`) leaves one. */
  async function seedInterrupted(opts: { supportsLoadSession?: boolean; adapterVersion?: string; sessionCwd?: string } = {}): Promise<{
    task: Awaited<ReturnType<TaskService['get']>>;
    run: RunRow;
    session: SessionRow;
  }> {
    const created = await tasks.create({ prompt: 'resume me', state: 'ready', workingDir: '/tmp/repo' });
    const run = await runStore.create(created.id);
    const session = await sessions.recordDispatch({
      harness: 'claude',
      harnessSessionId: `hsid-${run.id}`,
      model: 'stub-model',
      cwd: opts.sessionCwd ?? '/tmp/repo',
      workspaceId: null,
      mcpTemplates: [],
      capabilities: { protocolVersion: 1, agentCapabilities: { loadSession: opts.supportsLoadSession ?? true } } as never,
      adapterVersion: opts.adapterVersion ?? 'claude@1',
      now: Date.now(),
    });
    await runStore.update(run.id, { sessionId: session.harnessSessionId, sessionRowId: session.id });
    // What `markInterrupted` writes for a generic orphan.
    await runFacts.append(run.id, 'process-death', { runState: 'failed', taskAction: 'failed', reason: 'interrupted' });
    const failed = await runStore.update(run.id, { state: 'failed', phase: 'terminal', reason: 'interrupted', finishedAt: Date.now() });
    await tasks.setState(created.id, 'escalated');
    return { task: await tasks.get(created.id), run: failed, session };
  }

  /** `resolveCapabilities` matching the seeded Session on every axis unless
   * overridden. (The cwd axis is the coordinator's own — it compares the
   * Session's stored cwd to the Task's `workingDir`, both via `repoKey`.) */
  const capsFor =
    (over: Partial<ResumeCapabilities> = {}) =>
    (session: SessionRow): ResumeCapabilities => ({
      harness: session.harness,
      adapterVersion: session.adapterVersion ?? 'claude@1',
      model: session.model,
      availablePermissionModes: session.permissionMode ? [session.permissionMode] : [],
      ...over,
    });

  function coordinator(
    resolveCaps: (s: SessionRow) => ResumeCapabilities,
    opts: { now?: () => number; yielding?: YieldOptions } = {},
  ): BootResumeCoordinator {
    return new BootResumeCoordinator(runStore, attemptStore, tasks, sessions, turnQueue, runFacts, resolveCaps, opts);
  }

  it('compatible → resumes the SAME Session as a new Run + a crash-recovery turn on its harness id', async () => {
    const { task, run, session } = await seedInterrupted();

    await coordinator(capsFor()).resume();

    const runsForTask = (await runStore.listForTask(task.id)).filter((r) => r.id !== run.id);
    expect(runsForTask).toHaveLength(1);
    const resumeRun = runsForTask[0]!;
    const resumeAttempt = await attemptStore.getForTaskNumber(task.id, resumeRun.attempt);
    expect(resumeAttempt).toMatchObject({ taskId: task.id, number: resumeRun.attempt });
    expect(resumeRun.sessionRowId).toBe(session.id); // same Session
    expect(resumeRun.sessionId).toBe(session.harnessSessionId);
    expect(resumeRun.prompt).toBe(CRASH_RECOVERY_PROMPT);
    expect(resumeRun.chainId).toBe(run.chainId); // Execution Chain carried

    const queue = await turnQueue.listForSession(session.harnessSessionId);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ runId: resumeRun.id, purpose: 'crash-recovery', status: 'queued' });

    // Idempotency ledger + Task re-driven.
    expect((await runFacts.list(run.id)).some((f) => f.type === 'session-resumed')).toBe(true);
    expect((await runFacts.list(resumeRun.id)).find((f) => f.type === 'resume-entry')).toMatchObject({ attemptId: resumeAttempt!.id });
    expect((await tasks.get(task.id)).state).toBe('working');
  });

  it('incompatible (session/load unsupported) → fails forward: new Session, summarized prompt, reason recorded', async () => {
    const { task, run, session } = await seedInterrupted({ supportsLoadSession: false });

    await coordinator(capsFor()).resume();

    const resumeRun = (await runStore.listForTask(task.id)).find((r) => r.id !== run.id)!;
    expect(resumeRun.sessionRowId).toBeNull(); // NOT the dead Session — fresh on dispatch
    expect(resumeRun.sessionId).toBeNull();
    expect(resumeRun.prompt).toContain('# Resumed Session (Harmonic summary)');

    // The incompatibility is persisted on the dead Session (#145 AC5).
    expect((await sessions.get(session.id)).resumeIncompatibilityReason).toBe('load-session-unsupported');

    // The re-entry turn is queued on a fresh per-Run queue id (the `run-<id>`
    // convention the drive loop uses), not the dead Session's harness id.
    expect(await turnQueue.listForSession(session.harnessSessionId)).toHaveLength(0);
    const queue = await turnQueue.listForSession(`run-${resumeRun.id}`);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ purpose: 'crash-recovery', status: 'queued' });
  });

  it('incompatible (cwd / work-context moved) → fails forward with the cwd-mismatch reason', async () => {
    // The Session ran in a different working tree than the Task points at now
    // (Task.workingDir is '/tmp/repo'); the cwd axis compares the two.
    const { session, task, run } = await seedInterrupted({ sessionCwd: '/tmp/moved-away' });

    await coordinator(capsFor()).resume();

    const resumeRun = (await runStore.listForTask(task.id)).find((r) => r.id !== run.id)!;
    expect(resumeRun.sessionRowId).toBeNull();
    expect((await sessions.get(session.id)).resumeIncompatibilityReason).toBe('cwd-mismatch');
  });

  it('incompatible (adapter version drift) → fails forward with the adapter-version reason', async () => {
    const { session, task, run } = await seedInterrupted({ adapterVersion: 'claude@1' });

    // A harness/adapter upgrade across the restart: the current adapter version
    // differs from the one the Session was dispatched under.
    await coordinator(capsFor({ adapterVersion: 'claude@2' })).resume();

    const resumeRun = (await runStore.listForTask(task.id)).find((r) => r.id !== run.id)!;
    expect(resumeRun.sessionRowId).toBeNull();
    expect((await sessions.get(session.id)).resumeIncompatibilityReason).toBe('adapter-version-mismatch');
  });

  it('is idempotent — a second recovery pass creates no duplicate Run or turn (AC3)', async () => {
    const { task, run, session } = await seedInterrupted();
    const coord = coordinator(capsFor());

    await coord.resume();
    await coord.resume(); // repeat recovery

    expect((await runStore.listForTask(task.id)).filter((r) => r.id !== run.id)).toHaveLength(1);
    expect(await turnQueue.listForSession(session.harnessSessionId)).toHaveLength(1);
  });

  it('yields through a large resumable backlog instead of monopolizing the event loop', async () => {
    for (let i = 0; i < 12; i++) await seedInterrupted();
    let clock = 0;
    let yields = 0;
    const order: string[] = [];
    const coord = new BootResumeCoordinator(runStore, attemptStore, tasks, sessions, turnQueue, runFacts, capsFor(), {
      yielding: {
        budgetMs: 0,
        now: () => clock++,
        yieldNow: async () => {
          yields++;
          await yieldToEventLoop();
        },
      },
    });

    const done = coord.resume().then(() => order.push('done'));
    setImmediate(() => order.push('immediate'));
    await done;
    await yieldToEventLoop();

    expect(yields).toBeGreaterThan(0);
    expect(order.indexOf('immediate')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('immediate')).toBeLessThan(order.indexOf('done'));
    expect((await tasks.list({ state: 'working' })).length).toBe(12);
  });

  it('leaves an interrupted Run with no Session alone (nothing to resume)', async () => {
    const created = await tasks.create({ prompt: 'no session', state: 'ready', workingDir: '/tmp/repo' });
    const run = await runStore.create(created.id);
    await runStore.update(run.id, { state: 'failed', phase: 'terminal', reason: 'interrupted', finishedAt: Date.now() });

    await coordinator(capsFor()).resume();

    expect(await runStore.listForTask(created.id)).toHaveLength(1); // no resume Run
  });
});
