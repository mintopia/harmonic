import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig, UNATTENDED_REMINDER, type AppConfig } from '../src/config.js';
import { TaskService, type MirrorInput } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { ExecutionChainStore } from '../src/domain/execution-chain-store.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { workContextKey } from '../src/domain/work-context-key.js';
import { logger } from '../src/logger.js';
import { Runner } from '../src/execution/runner.js';
import { AutoDrive } from '../src/execution/auto-drive.js';
import { fillTemplate, skillFor, splitTitleBody } from '../src/execution/prompt-template.js';
import type { TaskRow, RunRow } from '../src/db/schema.js';
import { workspaces } from '../src/db/schema.js';
import type { Ticket, TrackerAdapter, OpenPRInput } from '../src/tracker/adapter.js';
import { allWorkspaces } from './helpers.js';

const STUB = join(import.meta.dirname, 'stub-harness.mjs');

const mirroredAfk = (ref: number, over: Partial<MirrorInput> = {}): MirrorInput => ({
  trackerRef: ref,
  prompt: `ticket ${ref}\n\nbody of ${ref}`,
  workflow: 'implement',
  wayfinderType: null,
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

/** The unattended reminder AutoDrive.prompt appends, with the Task id filled in. */
const reminder = (taskId: number) => UNATTENDED_REMINDER.replace(/\{taskId\}/g, String(taskId));

describe('Drive Prompt fill (issue #33)', () => {
  it('splits title/body, maps skill by workflow/type, and fills every placeholder', () => {
    expect(skillFor({ wayfinderType: 'research', harness: 'claude' })).toBe('/research');
    expect(skillFor({ wayfinderType: null, harness: 'claude' })).toBe('/implement');
    // Codex invokes skills with a `$` prefix; the name is otherwise unchanged.
    expect(skillFor({ wayfinderType: 'research', harness: 'codex' })).toBe('$research');
    expect(skillFor({ wayfinderType: null, harness: 'codex' })).toBe('$implement');
    expect(skillFor({ wayfinderType: null, harness: 'copilot' })).toBe('/implement');
    expect(splitTitleBody('T\n\nB1\n\nB2')).toEqual({ title: 'T', body: 'B1\n\nB2' });
    expect(splitTitleBody('only title')).toEqual({ title: 'only title', body: '' });

    const filled = fillTemplate('{skill} #{ref} {url}\n\n# {title}\n\n{body}', {
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
      drive: { ...defaultConfig().drive, prompt: '{skill} {ref} {url}\n\n{title}::{body}' },
    };
    const research = worktreeTask({ trackerRef: 9, wayfinderType: 'research', prompt: 'Investigate X\n\nwhy' });
    const drive = new AutoDrive(() => config, (task) => (task.trackerRef === 9 ? 'https://x/9' : null));
    expect(drive.prompt(research)).toBe(`/research 9 https://x/9\n\nInvestigate X::why\n\n${reminder(1)}`);
  });

  it('appends a re-queued mirrored Task’s feedback so the afk retry sees it', () => {
    const config: AppConfig = {
      ...defaultConfig(),
      drive: { ...defaultConfig().drive, prompt: '{skill} {ref}\n\n{title}::{body}' },
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
    expect(text).toMatch(/running unattended/i);
  });

  it('continuePrompt nudges the agent to resume and carries the reminder', () => {
    const config: AppConfig = { ...defaultConfig(), drive: { ...defaultConfig().drive, continueAttempts: 3 } };
    const drive = new AutoDrive(() => config, () => null);
    const text = drive.continuePrompt(worktreeTask({ id: 7 }));
    expect(text).toMatch(/isn't finished/i);
    expect(text).toContain('finish_task');
    expect(text).toContain('taskId=7');
    expect(drive.continueAttempts()).toBe(3);
  });

  it('closeTicket is idempotent and carries the caller\'s comment (the operator Close)', async () => {
    const open = fakeAdapter('open');
    const drive = new AutoDrive(() => defaultConfig(), () => null, async () => open.adapter);
    expect(await drive.closeTicket(worktreeTask(), 'Closed by a Harmonic operator without merging (task 1).')).toBe(true);
    expect(open.calls.close).toEqual([7]); // worktreeTask trackerRef

    // An already-closed ticket needs no second close (some trackers error on it).
    const closed = fakeAdapter('closed');
    const idempotent = new AutoDrive(() => defaultConfig(), () => null, async () => closed.adapter);
    expect(await idempotent.closeTicket(worktreeTask())).toBe(true);
    expect(closed.calls.close).toEqual([]);

    // A native Task with no ticket ref has nothing to close.
    expect(await drive.closeTicket(worktreeTask({ trackerRef: null }))).toBe(true);
  });

  it('completes after a verified merging when the adapter only supports inbound status', async () => {
    const inboundOnly: TrackerAdapter = {
      name: 'other',
      scan: async () => [],
      readTicket: async (ref) => ({
        number: ref.number,
        title: ref.title,
        state: 'open',
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
        url: '',
      }),
      claim: async () => {},
      release: async () => {},
    };
    const drive = new AutoDrive(() => defaultConfig(), () => null, async () => inboundOnly);
    expect(await drive.closeCompleted(worktreeTask())).toBe(true);
  });

  it('closeCompleted closes an open mirrored ticket via the adapter (issue #139)', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const drive = new AutoDrive(() => defaultConfig(), () => null, async () => adapter);
    expect(await drive.closeCompleted(worktreeTask())).toBe(true);
    expect(calls.close).toEqual([7]); // worktreeTask trackerRef
  });

  it('closeCompleted is idempotent — an already-closed ticket is not re-closed', async () => {
    const { adapter, calls } = fakeAdapter('closed');
    const drive = new AutoDrive(() => defaultConfig(), () => null, async () => adapter);
    expect(await drive.closeCompleted(worktreeTask())).toBe(true);
    expect(calls.close).toEqual([]); // a closed issue needs no second close (would error on gh)
  });
});

describe('AutoDrive.onCompleted — Merge Fate close-after-verify (issue #139)', () => {
  const cfg = (mergeFate: AppConfig['drive']['mergeFate']): AppConfig => ({
    ...defaultConfig(),
    drive: { ...defaultConfig().drive, prompt: '', mergeFate },
  });
  // finish_task (the Runner's agentFinished gate), not the agent closing the
  // ticket, is the signal that gets a Run here — so every fixture leaves the
  // ticket OPEN and asserts what Harmonic itself does about the close.

  it('auto-merge: the Runner has merged the verified tip, so Harmonic closes the ticket', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const drive = new AutoDrive(() => cfg('auto-merge'), () => null, async () => adapter);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('completed');
    expect(calls.close).toEqual([7]); // Harmonic closes it — trackerRef 7
  });

  it('auto-merge whose close fails escalates', async () => {
    const { adapter } = fakeAdapter('open');
    adapter.close = async () => {
      throw new Error('no permission to close');
    };
    const drive = new AutoDrive(() => cfg('auto-merge'), () => null, async () => adapter);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('escalate');
  });

  it('open-PR opens a PR and leaves the issue open — no close', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const drive = new AutoDrive(() => cfg('open-PR'), () => null, async () => adapter);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('completed');
    expect(calls.openPR).toHaveLength(1);
    expect(calls.openPR[0]).toMatchObject({ branch: 'harmonic/task-1-run-1', baseBranch: 'main' });
    expect(calls.close).toEqual([]); // the PR's own merge closes the issue later
  });

  it('open-PR that fails to create a PR escalates', async () => {
    const { adapter, calls } = fakeAdapter('open');
    adapter.openPR = async () => {
      throw new Error('no push permission');
    };
    const drive = new AutoDrive(() => cfg('open-PR'), () => null, async () => adapter);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('escalate');
    expect(calls.close).toEqual([]);
  });

  it('open-PR without PR capability degrades to artifact: completed, no close', async () => {
    const { adapter, calls } = fakeAdapter('open');
    delete adapter.openPR;
    const drive = new AutoDrive(() => cfg('open-PR'), () => null, async () => adapter);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('completed');
    expect(calls.close).toEqual([]);
  });

  it('artifact: leaves the branch and the ticket — no close', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const drive = new AutoDrive(() => cfg('artifact'), () => null, async () => adapter);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('completed');
    expect(calls.openPR).toEqual([]);
    expect(calls.close).toEqual([]);
  });

  it('research is always an artifact: no close', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const drive = new AutoDrive(() => cfg('auto-merge'), () => null, async () => adapter);
    expect(await drive.onCompleted(worktreeTask({ wayfinderType: 'research' }), run())).toBe('completed');
    expect(calls.close).toEqual([]);
  });

  it('direct-mode auto-merge: nothing to merge, but Harmonic still closes the ticket', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const drive = new AutoDrive(() => cfg('auto-merge'), () => null, async () => adapter);
    expect(
      await drive.onCompleted(worktreeTask({ isolationMode: 'direct' }), run({ branch: null, baseBranch: null })),
    ).toBe('completed');
    expect(calls.close).toEqual([7]);
  });
});

describe('Runner auto-drive settle (issue #33)', () => {
  let dir: string;
  let workDir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let runs: RunStore;
  let runner: Runner;

  const config = (over: Partial<AppConfig['drive']> = {}, maxAttempts = defaultConfig().maxAttempts): AppConfig => ({
    ...defaultConfig(),
    maxAttempts,
    harnesses: {
      ...defaultConfig().harnesses,
      claude: { command: process.execPath, args: [STUB], env: {}, models: ['stub'], defaultModel: 'stub' },
    },
    drive: { ...defaultConfig().drive, prompt: '{skill} #{ref}', ...over },
  });

  const startMirrored = async (id: number) => {
    await tasks.setState(id, 'working'); // the afk pick's lock, before launchClaimed (issue #32)
    await runner.launchClaimed(id);
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-drive-'));
    asyncDb = await openAsyncDb(dir);
    // The default workspace seeds `workingDir` to `process.cwd()` — the (dirty)
    // Harmonic repo during a test run, which these settle-logic tests must not
    // touch. Point the workspace at an isolated non-git directory so each Run
    // exercises its intended settle path (a non-git context yields no candidate).
    workDir = mkdtempSync(join(tmpdir(), 'harmonic-drive-wd-'));
    await asyncDb.write((d) => d.update(workspaces).set({ workingDir: workDir }).run());
  });
  afterEach(async () => {
    runner.shutdown();
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  function build(cfg: AppConfig, ticketState: 'open' | 'closed' = 'closed') {
    tasks = new TaskService(asyncDb, () => cfg, allWorkspaces(asyncDb));
    runs = new RunStore(asyncDb);
    // Default: a resolved (agent-closed) ticket so a clean run completes (ADR 0011).
    // 'open' leaves the ticket unresolved, so the continue loop engages.
    const drive = new AutoDrive(() => cfg, () => 'https://x/7', async () => fakeAdapter(ticketState).adapter);
    runner = new Runner(runs, tasks, new WorkContextLeaseStore(asyncDb), asyncDb, () => cfg, { autoDrive: drive });
  }

  const continueEvents = async (runId: number) =>
    (await runs.listEvents(runId)).filter((e) => e.type === 'lifecycle' && (e.payload as any).event === 'continue');

  it('a Run blocking on a human prompt fails the Attempt (no human drives it); the exhausted cap then Escalates', async () => {
    // The Drive Prompt template IS what reaches the harness — script the stub there.
    build(config({ prompt: JSON.stringify({ requestPermission: { title: 'Write file' } }) }, 2));
    const task = await tasks.upsertMirrored(mirroredAfk(7));
    await startMirrored(task.id);

    const settled = await vi.waitFor(async () => {
      const t = await tasks.get(task.id);
      if (t.state !== 'escalated') throw new Error(`still ${t.state}`);
      return t;
    }, { timeout: 10_000 });

    expect(settled.escalationReason).toMatch(/attempt 2 of 2 failed: permission request declined/);
    const attemptRows = await new AttemptStore(asyncDb).listForTask(task.id);
    expect(attemptRows.map((attempt) => attempt.state)).toEqual(['failed', 'escalated']);
    expect(attemptRows[0]!.feedback).toContain('Write file');
    const last = (await runs.listForTask(task.id)).at(-1)!;
    expect(last.state).toBe('failed');
    expect(last.reason).toContain('escalated to human');
  });

  it('an afk Run enters auto permission mode before prompting; an unfinished turn then uses the Attempt cap', async () => {
    build(config({ prompt: JSON.stringify({ echoSetMode: true }) }));
    const task = await tasks.upsertMirrored(mirroredAfk(7));
    await startMirrored(task.id);

    const settled = await vi.waitFor(async () => {
      const t = await tasks.get(task.id);
      if (t.state === 'working') throw new Error(`still ${t.state}`);
      return t;
    }, { timeout: 10_000 });

    expect(settled.state).toBe('escalated');
    const last = (await runs.listForTask(task.id)).at(-1)!;
    expect(last.attempt).toBe(2);
    const modeSet = (await runs.listEvents(last.id)).find(
      (e) => e.type === 'lifecycle' && (e.payload as any).event === 'mode_set',
    );
    expect((modeSet?.payload as any)?.mode).toBe('auto'); // session/set_mode auto went over the wire
  });

  it('an afk Run fails closed when the harness offers no unattended permission mode', async () => {
    const cfg = config({}, 1);
    cfg.harnesses.claude.env = { STUB_MODES: '' }; // advertise no session modes
    build(cfg);
    const task = await tasks.upsertMirrored(mirroredAfk(8));
    await startMirrored(task.id);

    const settled = await vi.waitFor(async () => {
      const t = await tasks.get(task.id);
      if (t.state === 'working') throw new Error(`still ${t.state}`);
      return t;
    }, { timeout: 10_000 });

    const last = (await runs.listForTask(task.id)).at(-1)!;
    expect(last.state).toBe('failed');
    expect(last.reason).toMatch(/unattended permission mode/);
    expect(settled.state).toBe('escalated'); // one permitted Attempt → escalates on the first failure
  });

  it('retries a failed afk Run within the cap, then Escalates when it is exhausted', async () => {
    // The Drive Prompt template reaches the harness; make it crash before responding.
    build(config({ prompt: JSON.stringify({ exit: 'crash-before-response' }) }, 2));
    const task = await tasks.upsertMirrored(mirroredAfk(7));

    // Attempt 1 fails. The unified loop immediately drives attempt 2 in the
    // same Run, then the cap escalates without creating a second Run.
    await startMirrored(task.id);
    const settled = await vi.waitFor(async () => {
      const t = await tasks.get(task.id);
      if (t.state !== 'escalated') throw new Error('not escalated yet');
      return t;
    }, { timeout: 10_000 });
    expect(settled.escalationReason).toMatch(/attempt 2 of 2 failed/);
    const taskAttempts = await new AttemptStore(asyncDb).listForTask(task.id);
    expect(taskAttempts.map((attempt) => ({ number: attempt.number, state: attempt.state }))).toEqual([
      { number: 1, state: 'failed' },
      { number: 2, state: 'escalated' },
    ]);
    const taskRuns = await runs.listForTask(task.id);
    expect(taskRuns).toHaveLength(1);
    expect(taskRuns[0]!.attempt).toBe(2);
  });

  it('re-prompts an unfinished (ticket-open) Run continueAttempts times, then treats it as unresolved', async () => {
    // The stub echoes the (non-JSON) drive prompt and ends its turn without
    // closing the ticket — exactly the "parked / not done" case. One permitted
    // the exhausted-continue unresolved path Escalates to a deterministic end.
    build(config({ continueAttempts: 2 }, 1), 'open');
    const task = await tasks.upsertMirrored(mirroredAfk(7));
    await startMirrored(task.id);

    const settled = await vi.waitFor(async () => {
      const t = await tasks.get(task.id);
      if (t.state !== 'escalated') throw new Error('not escalated yet');
      return t;
    }, { timeout: 10_000 });

    const lastRun = (await runs.listForTask(task.id)).at(-1)!;
    expect(await continueEvents(lastRun.id)).toHaveLength(2); // re-prompted exactly continueAttempts times
    expect(lastRun.reason).toMatch(/finish_task|escalated to human/);
    expect(settled.state).toBe('escalated');
  });

  it('continueAttempts 0 keeps the old single-turn behaviour — no continue re-prompt', async () => {
    build(config({ continueAttempts: 0 }, 1), 'open');
    const task = await tasks.upsertMirrored(mirroredAfk(7));
    await startMirrored(task.id);

    await vi.waitFor(async () => {
      if ((await tasks.get(task.id)).state !== 'escalated') throw new Error('not escalated yet');
    }, { timeout: 10_000 });

    const lastRun = (await runs.listForTask(task.id)).at(-1)!;
    expect(await continueEvents(lastRun.id)).toHaveLength(0); // straight to the unresolved path
  });

  it('a closed ticket alone no longer completes a Run — finish_task is the signal (#139)', async () => {
    // Pre-#139 a ticket the agent closed was the completion signal. Now
    // finish_task is: a Run whose ticket is already closed but which never signals
    // finish is NOT completed — it runs the continue budget and then Escalates as
    // unresolved. (The finish→verify→merge→close happy path needs the MCP endpoint
    // and is covered at the execution seam.)
    build(config({ continueAttempts: 0 }, 1), 'closed');
    const task = await tasks.upsertMirrored(mirroredAfk(7));
    await startMirrored(task.id);

    const settled = await vi.waitFor(async () => {
      const t = await tasks.get(task.id);
      if (t.state !== 'escalated') throw new Error('not escalated yet');
      return t;
    }, { timeout: 10_000 });

    expect(settled.state).toBe('escalated'); // a closed ticket did not complete it
    const lastRun = (await runs.listForTask(task.id)).at(-1)!;
    expect(lastRun.reason).toMatch(/finish_task|escalated to human/);
  });

  it('markAgentFinished / markEscalate no-op (return false) when the Task is not working here', () => {
    build(config());
    expect(runner.markAgentFinished(999)).toBe(false);
    expect(runner.markEscalate(999, 'need input')).toBe(false);
  });

  describe('acquireOrTransfer at the begin-transaction funnel (issue #124)', () => {
    // Seed a failed predecessor Run that still holds the direct-mode Work
    // Context lease for the workspace's `workDir` — the retained-lease handoff
    // state a successor begins into. Minted directly against the stores (not by
    // driving the predecessor async) so the test is deterministic. The chain is
    // fresh per call; whether a later successor SHARES it is decided by
    // resolveForTask from `taskId`, not here.
    async function seedPredecessorLease(
      taskId: number,
    ): Promise<{ predecessorId: number; key: string; leaseStore: WorkContextLeaseStore }> {
      const leaseStore = new WorkContextLeaseStore(asyncDb);
      const chainId = await new ExecutionChainStore(asyncDb).create();
      const predecessor = await runs.create(taskId, undefined, chainId);
      await runs.update(predecessor.id, { state: 'failed' });
      const key = workContextKey({ isolationMode: 'direct', workingDir: workDir });
      await leaseStore.acquire(key, predecessor.id, 'running');
      return { predecessorId: predecessor.id, key, leaseStore };
    }

    it('transfers a direct-mode lease to a successor sharing the Execution Chain, instead of conflicting', async () => {
      build(config());
      const task = await tasks.upsertMirrored(mirroredAfk(7));
      const { predecessorId, key, leaseStore } = await seedPredecessorLease(task.id);

      // The predecessor holds the lease on this Task's own chain, so the
      // successor's beginRun resolves the SAME Execution Chain (resolveForTask
      // branch 1: this Task's latest chained Run), so sharesLineOfWork is true
      // and the funnel transfers the lease instead of throwing conflict. The
      // claim commits inside beginRun's transaction synchronously, before the
      // async drive starts, so this asserts right after start returns rather
      // than waiting on the drive.
      await expect(startMirrored(task.id)).resolves.toBeUndefined();

      const successor = (await runs.listForTask(task.id)).at(-1)!;
      expect(successor.id).not.toBe(predecessorId);
      expect(await leaseStore.getByKey(key)).toMatchObject({ ownerRunId: successor.id });
      expect(await leaseStore.getByOwner(predecessorId)).toBeUndefined();
    });

    it('an unrelated (different-chain) direct predecessor no longer conflicts — the second worker attaches, lease untouched, traced at debug (ADR-0046, #369)', async () => {
      build(config());
      const otherTask = await tasks.upsertMirrored(mirroredAfk(8));
      const target = await tasks.upsertMirrored(mirroredAfk(9));

      // A predecessor Run on a DIFFERENT, unrelated Task (no reattempt link),
      // holding the SAME direct-mode key (same workspace workingDir).
      const { predecessorId, key, leaseStore } = await seedPredecessorLease(otherTask.id);

      // `target` has no chained Run of its own and no reattempt ancestry, so
      // resolveForTask mints it a fresh chain (branch 3) — different from the
      // predecessor's. sharesLineOfWork is false, so the funnel falls through to
      // acquire, which hits the unique-key CAS. Direct isolation no longer blocks
      // on that conflict (ADR-0046): the second worker attaching to the already-
      // claimed direct checkout is the operator's accepted risk — the funnel
      // proceeds and traces it at debug rather than throwing.
      await tasks.setState(target.id, 'working');
      const debugSpy = vi.spyOn(logger, 'debug');
      await expect(runner.launchClaimed(target.id)).resolves.toBeDefined();

      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining(`second worker attaching to already-claimed direct Work Context "${key}"`),
      );
      // The predecessor still owns the lease — the attach neither transferred nor
      // released it.
      expect(await leaseStore.getByKey(key)).toMatchObject({ ownerRunId: predecessorId });
      debugSpy.mockRestore();
    });
  });
});
