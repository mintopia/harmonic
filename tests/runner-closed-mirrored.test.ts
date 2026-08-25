import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService, type MirrorInput } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { Runner } from '../src/execution/runner.js';
import { AutoDrive } from '../src/execution/auto-drive.js';
import type { Ticket, TrackerAdapter } from '../src/tracker/adapter.js';
import { allWorkspaces } from './helpers.js';

// The premature-closure backstop with *no agent attached* (issue #139): a
// mirrored Task left `running` on the board while its ticket was closed in the
// tracker — but under the close-after-verify model only Harmonic closes a
// ticket, and only after verify + land (by which point the Task is terminal, not
// running). So a close seen here is premature: reopenClosedMirrored must reopen
// the ticket and Escalate the Task, never settle it done. (The agent-attached
// path is exercised via a live harness in auto-drive.test.ts.)

const mirrored = (ref: number, over: Partial<MirrorInput> = {}): MirrorInput => ({
  trackerRef: ref,
  prompt: `ticket ${ref}\n\nbody`,
  workflow: 'implement',
  wayfinderType: null,
  drive: 'afk',
  mapRef: null,
  closed: false,
  ...over,
});

/** A tracker adapter that records the tickets it was asked to reopen. */
function reopenSpy() {
  const reopened: number[] = [];
  const adapter: TrackerAdapter = {
    name: 'fake',
    scan: async () => [],
    readTicket: async (ref): Promise<Ticket> => ({
      number: ref.number,
      title: ref.title,
      state: 'closed',
      body: '',
      createdAt: '',
      closedAt: null,
      labels: [],
      assignees: [],
      parent: null,
      blockedBy: [],
      blocking: [],
      comments: [],
      isMap: false,
      url: `https://x/${ref.number}`,
    }),
    claim: async () => {},
    release: async () => {},
    close: async () => {},
    reopen: async (t) => {
      reopened.push(t.number);
    },
  };
  return { adapter, reopened };
}

describe('Runner.reopenClosedMirrored — no agent working the Task', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let runs: RunStore;
  let runner: Runner;
  let reopened: number[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-ccm-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
    runs = new RunStore(asyncDb);
    const spy = reopenSpy();
    reopened = spy.reopened;
    const drive = new AutoDrive(() => defaultConfig(), () => null, async () => spy.adapter);
    runner = new Runner(runs, tasks, new WorkContextLeaseStore(asyncDb), asyncDb, () => defaultConfig(), { autoDrive: drive });
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reopens the ticket and Escalates a still-running Task with no Run in flight', async () => {
    const task = await tasks.upsertMirrored(mirrored(7));
    await tasks.setState(task.id, 'running'); // flipped running, but nothing is driving it

    expect(await runner.reopenClosedMirrored(task.id)).toBe(true);
    const settled = await tasks.get(task.id);
    expect(settled.escalated).toBe(true); // handed to a human, NOT completed
    expect(settled.drive).toBe('hitl');
    expect(settled.state).not.toBe('completed');
    expect(reopened).toEqual([7]); // the premature close was reverted
  });

  it('does not complete, so a premature close leaves dependents not agent-workable', async () => {
    const blocker = await tasks.upsertMirrored(mirrored(1));
    const dependent = await tasks.create({ prompt: 'dependent', state: 'ready' });
    await tasks.addDependency(dependent.id, blocker.id);
    expect((await tasks.get(dependent.id)).state).toBe('ready');
    expect((await tasks.withDeps(await tasks.get(dependent.id))).openBlockerCount).toBe(1);
    expect((await tasks.withDeps(await tasks.get(dependent.id))).agentWorkable).toBe(false);
    await tasks.setState(blocker.id, 'running');

    await runner.reopenClosedMirrored(blocker.id);
    // The blocker was Escalated, not completed, so the dependent remains blocked by it.
    expect((await tasks.get(dependent.id)).state).toBe('ready');
    expect((await tasks.withDeps(await tasks.get(dependent.id))).openBlockerCount).toBe(1);
    expect((await tasks.withDeps(await tasks.get(dependent.id))).agentWorkable).toBe(false);
  });

  it('leaves a Task with a live Run row alone (a Run is mid-spawn)', async () => {
    const task = await tasks.upsertMirrored(mirrored(5));
    await tasks.setState(task.id, 'running');
    await runs.create(task.id); // Run row exists (state running); its ActiveRun not yet registered

    expect(await runner.reopenClosedMirrored(task.id)).toBe(false);
    expect((await tasks.get(task.id)).state).toBe('running');
    expect(reopened).toEqual([]);
  });

  it('reopens + Escalates once the in-flight Run row has finished without settling', async () => {
    const task = await tasks.upsertMirrored(mirrored(9));
    await tasks.setState(task.id, 'running');
    const run = await runs.create(task.id);
    await runs.finish(run.id, 'failed'); // Run ended but the Task was left running

    expect(await runner.reopenClosedMirrored(task.id)).toBe(true);
    expect((await tasks.get(task.id)).escalated).toBe(true);
    expect(reopened).toEqual([9]);
  });

  it('is a no-op on a Task that is no longer running', async () => {
    const task = await tasks.upsertMirrored(mirrored(3));
    await tasks.setState(task.id, 'running');
    await tasks.setState(task.id, 'completed'); // a racing settle won

    expect(await runner.reopenClosedMirrored(task.id)).toBe(false);
    expect((await tasks.get(task.id)).state).toBe('completed');
    expect(reopened).toEqual([]);
  });
});
