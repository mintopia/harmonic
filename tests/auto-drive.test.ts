import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig, UNATTENDED_REMINDER, type AppConfig } from '../src/config.js';
import { TaskService, type MirrorInput } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { Runner } from '../src/execution/runner.js';
import { AutoDrive, buildDrivePrompt, skillFor, splitTitleBody } from '../src/execution/auto-drive.js';
import type { TaskRow, RunRow } from '../src/db/schema.js';
import type { Ticket, TrackerAdapter, OpenPRInput } from '../src/tracker/adapter.js';
import { allWorkspaces } from './helpers.js';

const STUB = join(import.meta.dirname, 'stub-harness.mjs');

const mirroredAfk = (ref: number, over: Partial<MirrorInput> = {}): MirrorInput => ({
  trackerRef: ref,
  prompt: `ticket ${ref}\n\nbody of ${ref}`,
  workflow: 'implement',
  wayfinderType: null,
  drive: 'afk',
  mapRef: null,
  closed: false,
  ...over,
});

// A worktree Task + Run pair, crafted for the Merge Fate branch (no real git).
const worktreeTask = (over: Partial<TaskRow> = {}): TaskRow =>
  ({
    id: 1,
    trackerRef: 7,
    prompt: 'Fix the bug\n\ndetails',
    workingDir: '/repo',
    isolationMode: 'worktree',
    wayfinderType: null,
    origin: 'mirrored',
    drive: 'afk',
    ...over,
  }) as TaskRow;

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({ id: 1, attempt: 1, branch: 'harmonic/task-1-run-1', baseBranch: 'main', ...over }) as RunRow;

function fakeAdapter(ticketState: 'open' | 'closed' = 'open') {
  const calls = { close: [] as number[], reopen: [] as number[], openPR: [] as OpenPRInput[], read: [] as number[] };
  const adapter: TrackerAdapter = {
    name: 'fake',
    scan: async () => [],
    readTicket: async (ref): Promise<Ticket> => {
      calls.read.push(ref.number);
      return {
        number: ref.number,
        title: ref.title,
        state: ticketState,
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
      };
    },
    claim: async () => {},
    release: async () => {},
    whoami: async () => 'me',
    close: async (t) => {
      calls.close.push(t.number);
    },
    reopen: async (t) => {
      calls.reopen.push(t.number);
    },
    openPR: async (input) => {
      calls.openPR.push(input);
    },
  };
  return { adapter, calls };
}

const okGit = { merge: async () => ({ ok: true as const }) } as any;
const conflictGit = { merge: async () => ({ ok: false as const, detail: 'CONFLICT' }) } as any;

/** The unattended reminder AutoDrive.prompt appends, with the Task id filled in. */
const reminder = (taskId: number) => UNATTENDED_REMINDER.replace(/\{taskId\}/g, String(taskId));

describe('Drive Prompt fill (issue #33)', () => {
  it('splits title/body, maps skill by workflow/type, and fills every placeholder', () => {
    expect(skillFor({ wayfinderType: 'research' })).toBe('/research');
    expect(skillFor({ wayfinderType: null })).toBe('/implement');
    expect(splitTitleBody('T\n\nB1\n\nB2')).toEqual({ title: 'T', body: 'B1\n\nB2' });
    expect(splitTitleBody('only title')).toEqual({ title: 'only title', body: '' });

    const filled = buildDrivePrompt('{skill} #{ref} {url}\n\n# {title}\n\n{body}', {
      skill: '/implement',
      ref: '42',
      url: 'https://x/42',
      title: 'Add rate limiting',
      body: 'Cap POST /tasks',
    });
    expect(filled).toBe('/implement #42 https://x/42\n\n# Add rate limiting\n\nCap POST /tasks');
  });

  it('AutoDrive.prompt uses the global template, the ticket url, and the workflow skill', () => {
    const config: AppConfig = {
      ...defaultConfig(),
      drive: { prompt: '{skill} {ref} {url}\n\n{title}::{body}', mergeFate: 'auto-merge', autoRetry: 1, continueAttempts: 1 },
    };
    const research = worktreeTask({ trackerRef: 9, wayfinderType: 'research', prompt: 'Investigate X\n\nwhy' });
    const drive = new AutoDrive(() => config, (task) => (task.trackerRef === 9 ? 'https://x/9' : null));
    expect(drive.prompt(research)).toBe(`/research 9 https://x/9\n\nInvestigate X::why\n\n${reminder(1)}`);
  });

  it('appends a re-queued mirrored Task’s feedback so the afk retry sees it', () => {
    const config: AppConfig = {
      ...defaultConfig(),
      drive: { prompt: '{skill} {ref}\n\n{title}::{body}', mergeFate: 'auto-merge', autoRetry: 1, continueAttempts: 1 },
    };
    const drive = new AutoDrive(() => config, () => null);
    const withFeedback = worktreeTask({ trackerRef: 9, prompt: 'Fix it\n\ndetails', feedback: '  tests are red  ' });
    expect(drive.prompt(withFeedback)).toBe(
      `/implement 9\n\nFix it::details\n\n## Feedback from the previous attempt\n\ntests are red\n\n${reminder(1)}`,
    );
    // No feedback column → the drive prompt is just template + reminder.
    const plain = worktreeTask({ trackerRef: 9, prompt: 'Fix it\n\ndetails', feedback: null });
    expect(drive.prompt(plain)).toBe(`/implement 9\n\nFix it::details\n\n${reminder(1)}`);
  });

  it('the unattended reminder names both signal tools and this Task’s id', () => {
    const config: AppConfig = { ...defaultConfig(), drive: { ...defaultConfig().drive, prompt: '{skill}' } };
    const drive = new AutoDrive(() => config, () => null);
    const text = drive.prompt(worktreeTask({ id: 42 }));
    expect(text).toContain('finish_task');
    expect(text).toContain('escalate_task');
    expect(text).toContain('taskId=42');
    expect(text).toContain('running unattended');
  });

  it('continuePrompt nudges the agent to resume and carries the reminder', () => {
    const config: AppConfig = { ...defaultConfig(), drive: { ...defaultConfig().drive, continueAttempts: 3 } };
    const drive = new AutoDrive(() => config, () => null);
    const text = drive.continuePrompt(worktreeTask({ id: 7 }));
    expect(text).toMatch(/not finished/i);
    expect(text).toContain('finish_task');
    expect(text).toContain('taskId=7');
    expect(drive.continueAttempts()).toBe(3);
  });

  it('reopenTicket reverts a prematurely-closed ticket via the adapter', async () => {
    const { adapter, calls } = fakeAdapter('closed');
    const drive = new AutoDrive(() => defaultConfig(), () => null, async () => adapter);
    expect(await drive.reopenTicket(worktreeTask())).toBe(true);
    expect(calls.reopen).toEqual([7]); // worktreeTask trackerRef

    // A native/direct Task with no ticket ref never reopens.
    expect(await drive.reopenTicket(worktreeTask({ trackerRef: null }))).toBe(false);
  });
});

describe('AutoDrive.onFailed — Auto-Retry cap (issue #33)', () => {
  const cfg = (autoRetry: number): AppConfig => ({
    ...defaultConfig(),
    drive: { prompt: '', mergeFate: 'auto-merge', autoRetry, continueAttempts: 1 },
  });

  it('retries within the cap, then escalates — never a silent retry beyond it', () => {
    const drive = new AutoDrive(() => cfg(1), () => null);
    expect(drive.onFailed(worktreeTask(), run({ attempt: 1 }))).toBe('retry');
    expect(drive.onFailed(worktreeTask(), run({ attempt: 2 }))).toBe('escalate');
  });

  it('cap 0 escalates on the first failure', () => {
    const drive = new AutoDrive(() => cfg(0), () => null);
    expect(drive.onFailed(worktreeTask(), run({ attempt: 1 }))).toBe('escalate');
  });
});

describe('AutoDrive.onCompleted — Merge Fate close-after-verify (issue #139)', () => {
  const cfg = (mergeFate: AppConfig['drive']['mergeFate']): AppConfig => ({
    ...defaultConfig(),
    drive: { prompt: '', mergeFate, autoRetry: 1, continueAttempts: 1 },
  });
  const spyGit = () => ({ merge: vi.fn(async () => ({ ok: true as const })) });

  // finish_task (the Runner's agentFinished gate), not the agent closing the
  // ticket, is the signal that gets a Run here — so every fixture leaves the
  // ticket OPEN and asserts what Harmonic itself does about the close.

  it('auto-merge: merges the branch, then Harmonic closes the ticket', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const git = spyGit();
    const drive = new AutoDrive(() => cfg('auto-merge'), () => null, async () => adapter, git as any);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('completed');
    expect(git.merge).toHaveBeenCalledTimes(1);
    expect(calls.close).toEqual([7]); // Harmonic closes it — trackerRef 7
  });

  it('auto-merge conflict escalates and never closes the ticket', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const drive = new AutoDrive(() => cfg('auto-merge'), () => null, async () => adapter, conflictGit);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('escalate');
    expect(calls.close).toEqual([]);
  });

  it('auto-merge that merges but cannot close the ticket escalates', async () => {
    const { adapter } = fakeAdapter('open');
    const git = spyGit();
    adapter.close = async () => {
      throw new Error('no permission to close');
    };
    const drive = new AutoDrive(() => cfg('auto-merge'), () => null, async () => adapter, git as any);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('escalate');
    expect(git.merge).toHaveBeenCalledTimes(1); // the branch landed; only the close failed
  });

  it('open-PR opens a PR and leaves the issue open — no merge, no close', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const merge = vi.fn();
    const drive = new AutoDrive(() => cfg('open-PR'), () => null, async () => adapter, { merge } as any);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('completed');
    expect(merge).not.toHaveBeenCalled();
    expect(calls.openPR).toHaveLength(1);
    expect(calls.openPR[0]).toMatchObject({ branch: 'harmonic/task-1-run-1', baseBranch: 'main' });
    expect(calls.close).toEqual([]); // the PR's own merge closes the issue later
  });

  it('open-PR that fails to create a PR escalates', async () => {
    const { adapter, calls } = fakeAdapter('open');
    adapter.openPR = async () => {
      throw new Error('no push permission');
    };
    const drive = new AutoDrive(() => cfg('open-PR'), () => null, async () => adapter, okGit);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('escalate');
    expect(calls.close).toEqual([]);
  });

  it('open-PR without PR capability degrades to artifact: completed, no merge, no close', async () => {
    const { adapter, calls } = fakeAdapter('open');
    delete adapter.openPR;
    const merge = vi.fn();
    const drive = new AutoDrive(() => cfg('open-PR'), () => null, async () => adapter, { merge } as any);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('completed');
    expect(merge).not.toHaveBeenCalled();
    expect(calls.close).toEqual([]);
  });

  it('artifact: leaves the branch and the ticket — no merge, no close', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const merge = vi.fn();
    const drive = new AutoDrive(() => cfg('artifact'), () => null, async () => adapter, { merge } as any);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('completed');
    expect(merge).not.toHaveBeenCalled();
    expect(calls.openPR).toEqual([]);
    expect(calls.close).toEqual([]);
  });

  it('research is always an artifact: no merge, no close', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const merge = vi.fn();
    const drive = new AutoDrive(() => cfg('auto-merge'), () => null, async () => adapter, { merge } as any);
    expect(await drive.onCompleted(worktreeTask({ wayfinderType: 'research' }), run())).toBe('completed');
    expect(merge).not.toHaveBeenCalled();
    expect(calls.close).toEqual([]);
  });

  it('direct-mode auto-merge: nothing to merge, but Harmonic still closes the ticket', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const merge = vi.fn();
    const drive = new AutoDrive(() => cfg('auto-merge'), () => null, async () => adapter, { merge } as any);
    expect(
      await drive.onCompleted(worktreeTask({ isolationMode: 'direct' }), run({ branch: null, baseBranch: null })),
    ).toBe('completed');
    expect(merge).not.toHaveBeenCalled();
    expect(calls.close).toEqual([7]);
  });
});

describe('Runner auto-drive settle (issue #33)', () => {
  let dir: string;
  let db: Db;
  let tasks: TaskService;
  let runs: RunStore;
  let runner: Runner;

  const config = (over: Partial<AppConfig['drive']> = {}): AppConfig => ({
    ...defaultConfig(),
    harnesses: {
      ...defaultConfig().harnesses,
      claude: { command: process.execPath, args: [STUB], env: {}, models: ['stub'], defaultModel: 'stub' },
    },
    drive: { prompt: '{skill} #{ref}', mergeFate: 'auto-merge', autoRetry: 1, continueAttempts: 1, ...over },
  });

  const startMirrored = (id: number) => {
    tasks.setState(id, 'running'); // the afk pick's lock, before launchClaimed (issue #32)
    runner.launchClaimed(id);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-drive-'));
    db = openDb(dir);
  });
  afterEach(() => {
    runner.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  function build(cfg: AppConfig, ticketState: 'open' | 'closed' = 'closed') {
    tasks = new TaskService(db, () => cfg, allWorkspaces(db));
    runs = new RunStore(db);
    // Default: a resolved (agent-closed) ticket so a clean run completes (ADR 0011).
    // 'open' leaves the ticket unresolved, so the continue loop engages.
    const drive = new AutoDrive(() => cfg, () => 'https://x/7', async () => fakeAdapter(ticketState).adapter, okGit);
    runner = new Runner(runs, tasks, new WorkContextLeaseStore(db), db, () => cfg, { autoDrive: drive });
  }

  const continueEvents = (runId: number) =>
    runs.listEvents(runId).filter((e) => e.type === 'lifecycle' && (e.payload as any).event === 'continue');

  it('a Run blocking on a human prompt Escalates: stop, drive→hitl, ready + flag', async () => {
    // The Drive Prompt template IS what reaches the harness — script the stub there.
    build(config({ prompt: JSON.stringify({ requestPermission: { title: 'Write file' } }) }));
    const task = tasks.upsertMirrored(mirroredAfk(7));
    startMirrored(task.id);

    const settled = await vi.waitFor(() => {
      const t = tasks.get(task.id);
      if (t.state !== 'ready') throw new Error(`still ${t.state}`);
      return t;
    }, { timeout: 10_000 });

    expect(settled.state).toBe('ready');
    expect(settled.drive).toBe('hitl');
    expect(settled.escalated).toBe(true);
    const last = runs.listForTask(task.id).at(-1)!;
    expect(last.state).toBe('failed');
    expect(last.reason).toContain('escalated to human');
  });

  it('an afk Run enters auto permission mode before prompting, then runs unattended', async () => {
    build(config({ prompt: JSON.stringify({ echoSetMode: true }) }));
    const task = tasks.upsertMirrored(mirroredAfk(7));
    startMirrored(task.id);

    const settled = await vi.waitFor(() => {
      const t = tasks.get(task.id);
      if (t.state === 'running') throw new Error(`still ${t.state}`);
      return t;
    }, { timeout: 10_000 });

    expect(settled.escalated).toBe(false); // ran to completion, not escalated on a prompt
    expect(settled.drive).toBe('afk');
    const last = runs.listForTask(task.id).at(-1)!;
    const modeSet = runs
      .listEvents(last.id)
      .find((e) => e.type === 'lifecycle' && (e.payload as any).event === 'mode_set');
    expect((modeSet?.payload as any)?.mode).toBe('auto'); // session/set_mode auto went over the wire
  });

  it('an afk Run fails closed when the harness offers no unattended permission mode', async () => {
    const cfg = config({ autoRetry: 0 });
    cfg.harnesses.claude.env = { STUB_MODES: '' }; // advertise no session modes
    build(cfg);
    const task = tasks.upsertMirrored(mirroredAfk(8));
    startMirrored(task.id);

    const settled = await vi.waitFor(() => {
      const t = tasks.get(task.id);
      if (t.state === 'running') throw new Error(`still ${t.state}`);
      return t;
    }, { timeout: 10_000 });

    const last = runs.listForTask(task.id).at(-1)!;
    expect(last.state).toBe('failed');
    expect(last.reason).toMatch(/unattended permission mode/);
    expect(settled.escalated).toBe(true); // autoRetry 0 → escalates on the first failure
  });

  it('retries a failed afk Run within the cap, then Escalates when it is exhausted', async () => {
    // The Drive Prompt template reaches the harness; make it crash before responding.
    build(config({ autoRetry: 1, prompt: JSON.stringify({ exit: 'crash-before-response' }) }));
    const task = tasks.upsertMirrored(mirroredAfk(7));

    // Attempt 1 fails → retry: ready, still afk, not yet escalated.
    startMirrored(task.id);
    const afterFirst = await vi.waitFor(() => {
      const t = tasks.get(task.id);
      if (t.state !== 'ready') throw new Error(`still ${t.state}`);
      return t;
    }, { timeout: 10_000 });
    expect(afterFirst.drive).toBe('afk');
    expect(afterFirst.escalated).toBe(false);
    expect(runs.listForTask(task.id)).toHaveLength(1);

    // Attempt 2 fails → cap exhausted → Escalate: ready + hitl + flagged.
    startMirrored(task.id);
    const afterSecond = await vi.waitFor(() => {
      const t = tasks.get(task.id);
      if (!t.escalated) throw new Error('not escalated yet');
      return t;
    }, { timeout: 10_000 });
    expect(afterSecond.state).toBe('ready');
    expect(afterSecond.drive).toBe('hitl');
    expect(runs.listForTask(task.id)).toHaveLength(2);
  });

  it('re-prompts an unfinished (ticket-open) Run continueAttempts times, then treats it as unresolved', async () => {
    // The stub echoes the (non-JSON) drive prompt and ends its turn without
    // closing the ticket — exactly the "parked / not done" case. autoRetry 0 so
    // the exhausted-continue unresolved path Escalates to a deterministic end.
    build(config({ continueAttempts: 2, autoRetry: 0 }), 'open');
    const task = tasks.upsertMirrored(mirroredAfk(7));
    startMirrored(task.id);

    const settled = await vi.waitFor(() => {
      const t = tasks.get(task.id);
      if (!t.escalated) throw new Error('not escalated yet');
      return t;
    }, { timeout: 10_000 });

    const lastRun = runs.listForTask(task.id).at(-1)!;
    expect(continueEvents(lastRun.id)).toHaveLength(2); // re-prompted exactly continueAttempts times
    expect(lastRun.reason).toMatch(/finish_task|escalated to human/);
    expect(settled.escalated).toBe(true);
  });

  it('continueAttempts 0 keeps the old single-turn behaviour — no continue re-prompt', async () => {
    build(config({ continueAttempts: 0, autoRetry: 0 }), 'open');
    const task = tasks.upsertMirrored(mirroredAfk(7));
    startMirrored(task.id);

    await vi.waitFor(() => {
      if (!tasks.get(task.id).escalated) throw new Error('not escalated yet');
    }, { timeout: 10_000 });

    const lastRun = runs.listForTask(task.id).at(-1)!;
    expect(continueEvents(lastRun.id)).toHaveLength(0); // straight to the unresolved path
  });

  it('a closed ticket alone no longer completes a Run — finish_task is the signal (#139)', async () => {
    // Pre-#139 a ticket the agent closed was the completion signal. Now
    // finish_task is: a Run whose ticket is already closed but which never signals
    // finish is NOT completed — it runs the continue budget and then Escalates as
    // unresolved. (The finish→verify→land→close happy path needs the MCP endpoint
    // and is covered at the execution seam.)
    build(config({ continueAttempts: 0, autoRetry: 0 }), 'closed');
    const task = tasks.upsertMirrored(mirroredAfk(7));
    startMirrored(task.id);

    const settled = await vi.waitFor(() => {
      const t = tasks.get(task.id);
      if (!t.escalated) throw new Error('not escalated yet');
      return t;
    }, { timeout: 10_000 });

    expect(settled.state).not.toBe('completed'); // a closed ticket did not complete it
    const lastRun = runs.listForTask(task.id).at(-1)!;
    expect(lastRun.reason).toMatch(/finish_task|escalated to human/);
  });

  it('markAgentFinished / markEscalate no-op (return false) when the Task is not running here', () => {
    build(config());
    expect(runner.markAgentFinished(999)).toBe(false);
    expect(runner.markEscalate(999, 'need input')).toBe(false);
  });
});
