import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localMarkdownAdapter } from '../src/tracker/local-markdown.js';
import { Git } from '../src/execution/git.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig, UNATTENDED_REMINDER, type AppConfig } from '../src/config.js';
import { TaskService, type MirrorInput } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { Runner } from '../src/execution/runner.js';
import { AutoDrive } from '../src/execution/auto-drive.js';
import { fillTemplate, skillFor, splitTitleBody } from '../src/execution/prompt-template.js';
import type { TaskRow, AttemptRow } from '../src/db/schema.js';
import { workspaces } from '../src/db/schema.js';
import type { Ticket, TrackerAdapter, OpenPRInput } from '../src/tracker/adapter.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

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

const run = (over: Partial<AttemptRow> = {}): AttemptRow =>
  ({ id: 1, number: 1, branch: 'harmonic/task-1-run-1', baseBranch: 'main', ...over }) as AttemptRow;

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

const reminder = (taskId: number) => UNATTENDED_REMINDER.replace(/\{taskId\}/g, String(taskId));

describe('Drive Prompt fill (issue #33)', () => {
  it('splits title/body, maps skill by workflow/type, and fills every placeholder', () => {
    expect(skillFor({ wayfinderType: 'research', harness: 'claude' })).toBe('/research');
    expect(skillFor({ wayfinderType: null, harness: 'claude' })).toBe('/implement');
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

  it('AutoDrive.prompt uses the global template, the ticket url, and the workflow skill', async () => {
    const config: AppConfig = {
      ...baselineConfig(),
      drive: { ...baselineConfig().drive, prompt: '{skill} {ref} {url}\n\n{title}::{body}' },
    };
    const research = worktreeTask({ trackerRef: 9, wayfinderType: 'research', prompt: 'Investigate X\n\nwhy' });
    const drive = new AutoDrive(() => config, (task) => (task.trackerRef === 9 ? 'https://x/9' : null));
    expect(await drive.prompt(research)).toBe(`/research 9 https://x/9\n\nInvestigate X::why\n\n${reminder(1)}`);
  });

  it('drives a Map-Epic child with /wayfinder against the map ref, not its own ticket (issue #440)', async () => {
    const config: AppConfig = {
      ...baselineConfig(),
      drive: { ...baselineConfig().drive, prompt: '{skill} {ref} {url}\n\n{title}::{body}' },
    };
    const child = worktreeTask({ trackerRef: 7, mapRef: 100, workspaceId: 1, prompt: 'Chart it\n\nwhy' });
    const drive = new AutoDrive(
      () => config,
      (task) => `https://x/${task.trackerRef}`,
      undefined,
      undefined,
      async (_ws, ref) => (ref === 100 ? 'map' : null),
    );
    expect(await drive.prompt(child)).toBe(`/wayfinder 100 https://x/100\n\nChart it::why\n\n${reminder(1)}`);

    const plainChild = worktreeTask({ trackerRef: 7, mapRef: 200, workspaceId: 1, prompt: 'Build it\n\nnow' });
    const plainDrive = new AutoDrive(
      () => config,
      (task) => `https://x/${task.trackerRef}`,
      undefined,
      undefined,
      async () => 'epic',
    );
    expect(await plainDrive.prompt(plainChild)).toBe(`/implement 7 https://x/7\n\nBuild it::now\n\n${reminder(1)}`);
  });

  it('appends a re-queued mirrored Task’s feedback so the afk retry sees it', async () => {
    const config: AppConfig = {
      ...baselineConfig(),
      drive: { ...baselineConfig().drive, prompt: '{skill} {ref}\n\n{title}::{body}' },
    };
    const drive = new AutoDrive(() => config, () => null);
    const withFeedback = worktreeTask({ trackerRef: 9, prompt: 'Fix it\n\ndetails', feedback: '  tests are red  ' });
    expect(await drive.prompt(withFeedback)).toBe(
      `/implement 9\n\nFix it::details\n\n## Feedback from the previous attempt\n\ntests are red\n\n${reminder(1)}`,
    );
    const plain = worktreeTask({ trackerRef: 9, prompt: 'Fix it\n\ndetails', feedback: null });
    expect(await drive.prompt(plain)).toBe(`/implement 9\n\nFix it::details\n\n${reminder(1)}`);
  });

  it('the unattended reminder names both signal tools and this Task’s id', async () => {
    const config: AppConfig = { ...baselineConfig(), drive: { ...baselineConfig().drive, prompt: '{skill}' } };
    const drive = new AutoDrive(() => config, () => null);
    const text = await drive.prompt(worktreeTask({ id: 42 }));
    expect(text).toContain('finish_task');
    expect(text).toContain('escalate_task');
    expect(text).toContain('taskId=42');
    expect(text).toMatch(/running unattended/i);
  });

  it('continuePrompt nudges the agent to resume and carries the reminder', async () => {
    const config: AppConfig = { ...baselineConfig(), drive: { ...baselineConfig().drive, continueAttempts: 3 } };
    const drive = new AutoDrive(() => config, () => null);
    const text = await drive.continuePrompt(worktreeTask({ id: 7 }));
    expect(text).toMatch(/isn't finished/i);
    expect(text).toContain('finish_task');
    expect(text).toContain('taskId=7');
    expect(await drive.continueAttempts(worktreeTask({ id: 7 }))).toBe(3);
  });

  it('resolves every drive.* field per-Workspace via the injected resolver (#339)', async () => {
    const config: AppConfig = {
      ...baselineConfig(),
      drive: { ...baselineConfig().drive, prompt: 'GLOBAL {ref}', continueAttempts: 1, mergeFate: 'auto-merge' },
    };
    const wsOverride = {
      drivePrompt: 'WS {ref}',
      driveUnattendedReminder: 'ws-reminder {taskId}',
      driveContinuePrompt: 'ws-continue {taskId}',
      driveMergeFate: 'open-PR',
      driveContinueAttempts: 5,
    };
    const drive = new AutoDrive(() => config, () => null, undefined, async () => wsOverride as never);
    const task = worktreeTask({ id: 3, trackerRef: 9, workspaceId: 2 });
    expect(await drive.prompt(task)).toBe('WS 9\n\nws-reminder 3');
    expect(await drive.continuePrompt(task)).toBe('ws-continue 3\n\nws-reminder 3');
    expect(await drive.continueAttempts(task)).toBe(5);
    expect(await drive.mergeFateFor(task)).toBe('open-PR');

    const globalDrive = new AutoDrive(() => config, () => null, undefined, async () => undefined);
    expect(await globalDrive.mergeFateFor(task)).toBe('auto-merge');
    expect(await globalDrive.continueAttempts(task)).toBe(1);
  });

  it('closeTicket is idempotent and carries the caller\'s comment (the operator Close)', async () => {
    const open = fakeAdapter('open');
    const drive = new AutoDrive(() => baselineConfig(), () => null, async () => open.adapter);
    expect(await drive.closeTicket(worktreeTask(), 'Closed by a Harmonic operator without merging (task 1).')).toBe(true);
    expect(open.calls.close).toEqual([7]);

    const closed = fakeAdapter('closed');
    const idempotent = new AutoDrive(() => baselineConfig(), () => null, async () => closed.adapter);
    expect(await idempotent.closeTicket(worktreeTask())).toBe(true);
    expect(closed.calls.close).toEqual([]);

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
    const drive = new AutoDrive(() => baselineConfig(), () => null, async () => inboundOnly);
    expect(await drive.closeCompleted(worktreeTask())).toBe(true);
  });

  it('closeCompleted closes an open mirrored ticket via the adapter (issue #139)', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const drive = new AutoDrive(() => baselineConfig(), () => null, async () => adapter);
    expect(await drive.closeCompleted(worktreeTask())).toBe(true);
    expect(calls.close).toEqual([7]);
  });

  it('closeCompleted is idempotent — an already-closed ticket is not re-closed', async () => {
    const { adapter, calls } = fakeAdapter('closed');
    const drive = new AutoDrive(() => baselineConfig(), () => null, async () => adapter);
    expect(await drive.closeCompleted(worktreeTask())).toBe(true);
    expect(calls.close).toEqual([]);
  });

  it('fires onTicketClosed only on a genuine close — never on an already-closed ticket or a Task with no ref', async () => {
    const closed: (number | null)[] = [];
    const open = fakeAdapter('open');
    const drive = new AutoDrive(() => baselineConfig(), () => null, async () => open.adapter, undefined, undefined, (task) => closed.push(task.trackerRef));
    await drive.closeCompleted(worktreeTask());
    expect(closed).toEqual([7]);

    const already = fakeAdapter('closed');
    const idempotent = new AutoDrive(() => baselineConfig(), () => null, async () => already.adapter, undefined, undefined, (task) => closed.push(task.trackerRef));
    await idempotent.closeCompleted(worktreeTask());
    await idempotent.closeTicket(worktreeTask({ trackerRef: null }));
    expect(closed).toEqual([7]);
  });
});

describe('AutoDrive.onCompleted — Merge Fate close-after-verify (issue #139)', () => {
  const cfg = (mergeFate: AppConfig['drive']['mergeFate']): AppConfig => ({
    ...baselineConfig(),
    drive: { ...baselineConfig().drive, prompt: '', mergeFate },
  });

  it('auto-merge: the Runner has merged the verified tip, so Harmonic closes the ticket', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const drive = new AutoDrive(() => cfg('auto-merge'), () => null, async () => adapter);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('completed');
    expect(calls.close).toEqual([7]);
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
    expect(calls.close).toEqual([]);
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
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let runner: Runner;

  const config = (over: Partial<AppConfig['drive']> = {}, maxAttempts = baselineConfig().maxAttempts): AppConfig => ({
    ...baselineConfig(),
    maxAttempts,
    harnesses: {
      ...baselineConfig().harnesses,
      claude: {
        command: process.execPath,
        args: [STUB],
        env: {},
        models: [{ id: 'stub' }],
        defaultModel: 'stub',
        cacheWarmSeconds: 300,
      },
    },
    drive: { ...baselineConfig().drive, prompt: '{skill} #{ref}', ...over },
  });

  const startMirrored = async (id: number) => {
    await tasks.setState(id, 'working');
    await runner.launchClaimed(id);
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-drive-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
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
    tasks = new TaskService(asyncDb, () => cfg, allWorkspaces(asyncDb, settingsStore));
    attempts = new AttemptStore(asyncDb);
    const drive = new AutoDrive(() => cfg, () => 'https://x/7', async () => fakeAdapter(ticketState).adapter);
    runner = new Runner(tasks, asyncDb, () => cfg, { autoDrive: drive });
  }

  const eventsForRun = async (run: AttemptRow) => attempts.listEvents(run.id);

  const eventsForTask = async (taskId: number) => {
    const rows = await attempts.listForTask(taskId);
    const perAttempt = await Promise.all(rows.map((row) => attempts.listEvents(row.id)));
    return perAttempt.flat();
  };

  const continueEvents = async (run: AttemptRow) =>
    (await eventsForRun(run)).filter((e) => e.type === 'lifecycle' && (e.payload as any).event === 'continue');

  it('a Run blocking on a human prompt fails the Attempt (no human drives it); the exhausted cap then Escalates', async () => {
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
    const last = (await attempts.listForTask(task.id)).at(-1)!;
    expect(last.state).toBe('escalated');
    expect(last.detail).toContain('escalated to human');
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
    const last = (await attempts.listForTask(task.id)).at(-1)!;
    expect(last.number).toBe(2);
    const modeSet = (await eventsForTask(task.id)).find(
      (e) => e.type === 'lifecycle' && (e.payload as any).event === 'mode_set',
    );
    expect((modeSet?.payload as any)?.mode).toBe('auto');
  });

  it('an afk Run fails closed when the harness offers no unattended permission mode', async () => {
    const cfg = config({}, 1);
    cfg.harnesses.claude.env = { STUB_MODES: '' };
    build(cfg);
    const task = await tasks.upsertMirrored(mirroredAfk(8));
    await startMirrored(task.id);

    const settled = await vi.waitFor(async () => {
      const t = await tasks.get(task.id);
      if (t.state === 'working') throw new Error(`still ${t.state}`);
      return t;
    }, { timeout: 10_000 });

    const last = (await attempts.listForTask(task.id)).at(-1)!;
    expect(last.state).toBe('escalated');
    expect(last.detail).toMatch(/unattended permission mode/);
    expect(settled.state).toBe('escalated');
  });

  it('retries a failed afk Run within the cap, then Escalates when it is exhausted', async () => {
    build(config({ prompt: JSON.stringify({ exit: 'crash-before-response' }) }, 2));
    const task = await tasks.upsertMirrored(mirroredAfk(7));

    await startMirrored(task.id);
    const settled = await vi.waitFor(async () => {
      const t = await tasks.get(task.id);
      if (t.state !== 'escalated') throw new Error('not escalated yet');
      return t;
    }, { timeout: 10_000 });
    expect(settled.escalationReason).toMatch(/attempt 2 of 2 failed/);
    const taskAttempts = await attempts.listForTask(task.id);
    expect(taskAttempts.map((attempt) => ({ number: attempt.number, state: attempt.state }))).toEqual([
      { number: 1, state: 'failed' },
      { number: 2, state: 'escalated' },
    ]);
    expect(taskAttempts[1]!.branch).toBe(taskAttempts[0]!.branch);
  });

  it('re-prompts an unfinished (ticket-open) Run continueAttempts times, then treats it as unresolved', async () => {
    build(config({ continueAttempts: 2 }, 1), 'open');
    const task = await tasks.upsertMirrored(mirroredAfk(7));
    await startMirrored(task.id);

    const settled = await vi.waitFor(async () => {
      const t = await tasks.get(task.id);
      if (t.state !== 'escalated') throw new Error('not escalated yet');
      return t;
    }, { timeout: 10_000 });

    const lastRun = (await attempts.listForTask(task.id)).at(-1)!;
    expect(await continueEvents(lastRun)).toHaveLength(2);
    expect(lastRun.detail).toMatch(/finish_task|escalated to human/);
    expect(settled.state).toBe('escalated');
  });

  it('continueAttempts 0 keeps the old single-turn behaviour — no continue re-prompt', async () => {
    build(config({ continueAttempts: 0 }, 1), 'open');
    const task = await tasks.upsertMirrored(mirroredAfk(7));
    await startMirrored(task.id);

    await vi.waitFor(async () => {
      if ((await tasks.get(task.id)).state !== 'escalated') throw new Error('not escalated yet');
    }, { timeout: 10_000 });

    const lastRun = (await attempts.listForTask(task.id)).at(-1)!;
    expect(await continueEvents(lastRun)).toHaveLength(0);
  });

  it('a closed ticket alone no longer completes a Run — finish_task is the signal (#139)', async () => {
    build(config({ continueAttempts: 0 }, 1), 'closed');
    const task = await tasks.upsertMirrored(mirroredAfk(7));
    await startMirrored(task.id);

    const settled = await vi.waitFor(async () => {
      const t = await tasks.get(task.id);
      if (t.state !== 'escalated') throw new Error('not escalated yet');
      return t;
    }, { timeout: 10_000 });

    expect(settled.state).toBe('escalated');
    const lastRun = (await attempts.listForTask(task.id)).at(-1)!;
    expect(lastRun.detail).toMatch(/finish_task|escalated to human/);
  });

  it('markAgentFinished / markEscalate no-op (return false) when the Task is not working here', () => {
    build(config());
    expect(runner.markAgentFinished(999)).toBe(false);
    expect(runner.markEscalate(999, 'need input')).toBe(false);
  });
});

describe('AutoDrive.closeTicket — file-backed tracker commits its status change to base (ADR-0004)', () => {
  let repo: string;
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]).toString().trim();

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'harmonic-md-close-'));
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 'Tester');
    mkdirSync(join(repo, '.scratch', 'issues'), { recursive: true });
    writeFileSync(
      join(repo, '.scratch', 'issues', '07-fix.md'),
      '# 07 — Fix the bug\n\n**Status:** ready-for-agent\n\n- [ ] do it\n',
    );
    g('add', '-A');
    g('commit', '-q', '-m', 'seed ticket');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('closes the ticket, commits it onto the base branch, and leaves the checkout clean', async () => {
    const adapter = localMarkdownAdapter(join(repo, '.scratch'));
    const drive = new AutoDrive(() => baselineConfig(), () => null, async () => adapter);
    const task = worktreeTask({ trackerRef: 7, workingDir: repo });
    const before = Number(g('rev-list', '--count', 'HEAD'));

    expect(await drive.closeTicket(task, 'Completed and merged by Harmonic (task 1).')).toBe(true);

    expect(readFileSync(join(repo, '.scratch', 'issues', '07-fix.md'), 'utf8')).toContain('**Status:** closed');
    // The fix: the status write is committed, so the base checkout is never left dirty.
    expect(await Git.isDirty(repo)).toBe(false);
    expect(Number(g('rev-list', '--count', 'HEAD'))).toBe(before + 1);
    expect(g('show', '--name-only', '--format=', 'HEAD')).toContain('.scratch/issues/07-fix.md');
    // Committed onto the base branch itself, not a detached HEAD.
    expect(g('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('is idempotent — re-closing an already-closed ticket commits nothing and stays clean', async () => {
    const adapter = localMarkdownAdapter(join(repo, '.scratch'));
    const drive = new AutoDrive(() => baselineConfig(), () => null, async () => adapter);
    const task = worktreeTask({ trackerRef: 7, workingDir: repo });

    expect(await drive.closeTicket(task)).toBe(true);
    const afterFirst = g('rev-list', '--count', 'HEAD');

    expect(await drive.closeTicket(task)).toBe(true);
    expect(g('rev-list', '--count', 'HEAD')).toBe(afterFirst);
    expect(await Git.isDirty(repo)).toBe(false);
  });
});
