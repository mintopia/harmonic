import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localMarkdownAdapter } from '../src/tracker/local-markdown.js';
import { Git } from '../src/execution/git.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { TaskService, type MirrorInput } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { Runner } from '../src/execution/runner.js';
import { AutoDrive } from '../src/execution/auto-drive.js';
import { fillTemplate, skillFor, splitTitleBody } from '../src/execution/prompt-template.js';
import type { TaskRow, AttemptRow } from '../src/db/schema.js';
import { workspaces } from '../src/db/schema.js';
import type { Ticket, TrackerAdapter } from '../src/tracker/adapter.js';
import type { OpenPRInput, RepositoryAdapter } from '../src/repository/adapter.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { executionPlumbing, allWorkspaces, makeSettingsStore, migratedWorkflowOptions, seedWorkspace } from './helpers.js';
import { trackerRef } from '../src/tracker/adapter.js';
import { logger } from '../src/logger.js';

const STUB = join(import.meta.dirname, 'stub-harness.mjs');

const mirroredAfk = (ref: number, over: Partial<MirrorInput> = {}): MirrorInput => ({
  trackerRef: trackerRef(ref),
  prompt: `ticket ${ref}\n\nbody of ${ref}`,
  issueWorkflow: 'implement',
  wayfinderType: null,
  mapRef: null,
  closed: false,
  ...over,
});

const worktreeTask = (over: Partial<TaskRow> = {}): TaskRow =>
  ({
    id: 1,
    trackerRef: trackerRef(7),
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
  const calls = { close: [] as string[], reopen: [] as string[], openPR: [] as OpenPRInput[], read: [] as string[] };
  const adapter: TrackerAdapter = {
    name: 'fake',
    scan: async () => [],
    readTicket: async (ref): Promise<Ticket> => {
      calls.read.push(ref.ref);
      return {
        ref: ref.ref,
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
        isMap: false,
        url: `https://x/${ref.ref}`,
      };
    },
    claim: async () => {},
    release: async () => {},
    close: async (t) => {
      calls.close.push(t.ref);
    },
    reopen: async (t) => {
      calls.reopen.push(t.ref);
    },
  };
  const repository: RepositoryAdapter = {
    kind: 'fake',
    openPR: async (input) => {
      calls.openPR.push(input);
      return 'https://github.com/o/r/pull/9';
    },
    verify: async () => ({ ok: true }),
  };
  return { adapter, repository, calls };
}


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

  it('closeTicket is idempotent and carries the caller\'s comment (the operator Close)', async () => {
    const open = fakeAdapter('open');
    const drive = new AutoDrive(() => null, async () => open.adapter);
    expect(await drive.closeTicket(worktreeTask(), 'Closed by a Harmonic operator without merging (task 1).')).toBe(true);
    expect(open.calls.close).toEqual(['7']);

    const closed = fakeAdapter('closed');
    const idempotent = new AutoDrive(() => null, async () => closed.adapter);
    expect(await idempotent.closeTicket(worktreeTask())).toBe(true);
    expect(closed.calls.close).toEqual([]);

    expect(await drive.closeTicket(worktreeTask({ trackerRef: null }))).toBe(true);
  });

  it('completes after a verified merging when the adapter only supports inbound status', async () => {
    const inboundOnly: TrackerAdapter = {
      name: 'other',
      scan: async () => [],
      readTicket: async (ref) => ({
        ref: ref.ref,
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
        isMap: false,
        url: '',
      }),
      claim: async () => {},
      release: async () => {},
    };
    const drive = new AutoDrive(() => null, async () => inboundOnly);
    expect(await drive.closeTicket(worktreeTask())).toBe(true);
  });

  it('closeTicket closes an open mirrored ticket via the adapter (issue #139)', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const drive = new AutoDrive(() => null, async () => adapter);
    expect(await drive.closeTicket(worktreeTask())).toBe(true);
    expect(calls.close).toEqual(['7']);
  });

  it('fires onTicketClosed only on a genuine close — never on an already-closed ticket or a Task with no ref', async () => {
    const closed: (string | null)[] = [];
    const open = fakeAdapter('open');
    const drive = new AutoDrive(() => null, async () => open.adapter, undefined, undefined, (task) => closed.push(task.trackerRef));
    await drive.closeTicket(worktreeTask());
    expect(closed).toEqual(['7']);

    const already = fakeAdapter('closed');
    const idempotent = new AutoDrive(() => null, async () => already.adapter, undefined, undefined, (task) => closed.push(task.trackerRef));
    await idempotent.closeTicket(worktreeTask());
    await idempotent.closeTicket(worktreeTask({ trackerRef: null }));
    expect(closed).toEqual(['7']);
  });
});

describe('AutoDrive.openPullRequest and retryTicketClose (issue #139)', () => {
  it('retryTicketClose reports the error without recording a close-failed event', async () => {
    const { adapter } = fakeAdapter('open');
    adapter.close = async () => {
      throw new Error('API rate limit exceeded');
    };
    const failures: unknown[] = [];
    const drive = new AutoDrive(() => null, async () => adapter, undefined, undefined, undefined, (_task, err) => failures.push(err));
    const result = await drive.retryTicketClose(worktreeTask());
    expect(result.ok).toBe(false);
    expect(failures).toEqual([]);
  });

  it('opens a PR for the Attempt branch and does not close the issue', async () => {
    const { adapter, repository, calls } = fakeAdapter('open');
    const drive = new AutoDrive(() => null, async () => adapter, undefined, undefined, undefined, undefined, async () => repository);
    expect(await drive.openPullRequest(worktreeTask(), run())).toBe('https://github.com/o/r/pull/9');
    expect(calls.openPR).toHaveLength(1);
    expect(calls.openPR[0]).toMatchObject({ branch: 'harmonic/task-1-run-1', baseBranch: 'main' });
    expect(calls.close).toEqual([]);
  });

  it('records the PR URL on the Attempt that opened it', async () => {
    const { adapter, repository } = fakeAdapter('open');
    const recorded: Array<{ attempt: number; url: string }> = [];
    const drive = new AutoDrive(() => null, async () => adapter, undefined, undefined, undefined, undefined, async () => repository, async (r, url) => {
      recorded.push({ attempt: r.id, url });
    });
    await drive.openPullRequest(worktreeTask(), run());
    expect(recorded).toEqual([{ attempt: 1, url: 'https://github.com/o/r/pull/9' }]);
  });

  it('records nothing when the Code Repository opened no PR', async () => {
    const { adapter, repository } = fakeAdapter('open');
    repository.openPR = async () => null;
    const recorded: string[] = [];
    const drive = new AutoDrive(() => null, async () => adapter, undefined, undefined, undefined, undefined, async () => repository, async (_r, url) => {
      recorded.push(url);
    });
    expect(await drive.openPullRequest(worktreeTask(), run())).toBeNull();
    expect(recorded).toEqual([]);
  });

  it('names the ticket as its kind writes it: PROJ-185 for Jira, #185 for a detected GitHub tracker', async () => {
    const { adapter, repository, calls } = fakeAdapter('open');
    const jira = new AutoDrive(() => null, async () => adapter, async () => ({ configuredTracker: JSON.stringify({ kind: 'jira', settings: {} }) }) as never, undefined, undefined, undefined, async () => repository);
    await jira.openPullRequest(worktreeTask({ trackerRef: trackerRef('PROJ-185') }), run());
    expect(calls.openPR[0]!.body).toBe('Auto-driven by Harmonic for PROJ-185.');

    const repo = mkdtempSync(join(tmpdir(), 'harmonic-autodrive-'));
    mkdirSync(join(repo, 'docs/agents'), { recursive: true });
    writeFileSync(join(repo, 'docs/agents/issue-tracker.md'), '# Issue tracker: GitHub\n');
    try {
      const github = new AutoDrive(() => null, async () => adapter, undefined, undefined, undefined, undefined, async () => repository);
      await github.openPullRequest(worktreeTask({ trackerRef: trackerRef('185'), workingDir: repo }), run());
      expect(calls.openPR[1]!.body).toBe('Auto-driven by Harmonic for #185.');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('throws when the forge refuses to create the PR', async () => {
    const { adapter, repository } = fakeAdapter('open');
    repository.openPR = async () => {
      throw new Error('no push permission');
    };
    const drive = new AutoDrive(() => null, async () => adapter, undefined, undefined, undefined, undefined, async () => repository);
    await expect(drive.openPullRequest(worktreeTask(), run())).rejects.toThrow('no push permission');
  });

  it('returns null without a Code Repository', async () => {
    const { adapter } = fakeAdapter('open');
    const drive = new AutoDrive(() => null, async () => adapter, undefined, undefined, undefined, undefined, async () => null);
    expect(await drive.openPullRequest(worktreeTask(), run())).toBeNull();
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
    await seedWorkspace(asyncDb);
    settingsStore = await makeSettingsStore(dir);
    workDir = mkdtempSync(join(tmpdir(), 'harmonic-drive-wd-'));
    await asyncDb.write((d) => d.update(workspaces).set({ workingDir: workDir }).run());
  });
  afterEach(async () => {
    await runner.shutdown();
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  async function build(cfg: AppConfig, ticketState: 'open' | 'closed' = 'closed') {
    const migrated = await migratedWorkflowOptions(cfg, dir);
    tasks = new TaskService(asyncDb, () => migrated.config, allWorkspaces(asyncDb, settingsStore));
    attempts = new AttemptStore(asyncDb);
    const drive = new AutoDrive(() => 'https://x/7', async () => fakeAdapter(ticketState).adapter);
    runner = new Runner(tasks, asyncDb, () => migrated.config, { ...executionPlumbing(), autoDrive: drive, promptLibrary: migrated.promptLibrary, workflows: migrated.workflows });
  }

  const eventsForTask = async (taskId: number) => {
    const rows = await attempts.listForTask(taskId);
    const perAttempt = await Promise.all(rows.map((row) => attempts.listEvents(row.id)));
    return perAttempt.flat();
  };

  it('a crash inside the agent loop is logged and settles the Attempt escalated, freeing the slot (#853)', async () => {
    await build(config());
    vi.spyOn((runner as any).workflowEngine, 'run').mockRejectedValue(new Error('db timeout'));
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const task = await tasks.upsertMirrored(mirroredAfk(7));
    await startMirrored(task.id);

    const settled = await vi.waitFor(async () => {
      const t = await tasks.get(task.id);
      if (t.state === 'working') throw new Error('still working');
      return t;
    }, { timeout: 10_000 });

    expect(settled.state).toBe('escalated');
    expect(settled.escalationReason).toMatch(/workflow engine crashed: db timeout/);
    const [attempt] = await attempts.listForTask(task.id);
    expect(attempt!.state).toBe('escalated');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('workflow engine crashed: db timeout'));
    expect((await tasks.list()).filter((t) => t.state === 'working')).toHaveLength(0);
  });

  it('a Run blocking on a human prompt fails the Attempt (no human drives it); the exhausted cap then Escalates', async () => {
    await build(config({ prompt: JSON.stringify({ requestPermission: { title: 'Write file' } }) }, 2));
    const task = await tasks.upsertMirrored(mirroredAfk(7));
    await startMirrored(task.id);

    const settled = await vi.waitFor(async () => {
      const t = await tasks.get(task.id);
      if (t.state !== 'escalated') throw new Error(`still ${t.state}`);
      return t;
    }, { timeout: 10_000 });

    expect(settled.escalationReason).toMatch(/workflow attempts exhausted after 2: .*permission request declined/);
    expect(settled.escalationReason).toContain('Write file');
    const attemptRows = await new AttemptStore(asyncDb).listForTask(task.id);
    expect(attemptRows.map((attempt) => attempt.state)).toEqual(['escalated']);
    const last = (await attempts.listForTask(task.id)).at(-1)!;
    expect(last.state).toBe('escalated');
    expect(last.detail).toContain('escalated to human');
  });

  it('an afk Run enters auto permission mode before prompting', async () => {
    await build(config({ prompt: JSON.stringify({ echoSetMode: true }) }));
    const task = await tasks.upsertMirrored(mirroredAfk(7));
    await startMirrored(task.id);

    const settled = await vi.waitFor(async () => {
      const t = await tasks.get(task.id);
      if (t.state === 'working') throw new Error(`still ${t.state}`);
      return t;
    }, { timeout: 10_000 });

    expect(settled.state).toBe('done');
    const modeSet = (await eventsForTask(task.id)).find(
      (e) => e.type === 'lifecycle' && (e.payload as any).event === 'mode_set',
    );
    expect(modeSet?.payload).toMatchObject({
      mode: 'auto',
      requested: null,
      advertised: ['default', 'auto', 'bypassPermissions'],
      applied: 'auto',
      fallbackReason: null,
    });
  });

  it('an afk Run uses its Harness permission-mode configuration when ACP advertises it', async () => {
    const cfg = config({ prompt: JSON.stringify({ echoSetMode: true }) });
    cfg.harnesses.claude.permissionMode = 'bypassPermissions';
    await build(cfg);
    const task = await tasks.upsertMirrored(mirroredAfk(7));
    await startMirrored(task.id);

    await vi.waitFor(async () => {
      const modeSet = (await eventsForTask(task.id)).find(
        (event) => event.type === 'lifecycle' && (event.payload as any).event === 'mode_set',
      );
      if (!modeSet) throw new Error('mode not set');
      return modeSet;
    }, { timeout: 10_000 });

    const modeSet = (await eventsForTask(task.id)).find(
      (event) => event.type === 'lifecycle' && (event.payload as any).event === 'mode_set',
    );
    expect(modeSet?.payload).toMatchObject({
      mode: 'bypassPermissions',
      requested: 'bypassPermissions',
      applied: 'bypassPermissions',
      fallbackReason: null,
    });
  });

  it('an afk Run visibly falls back when its configured permission mode is not advertised', async () => {
    const cfg = config({ prompt: JSON.stringify({ echoSetMode: true }) });
    cfg.harnesses.claude.permissionMode = 'bypassPermissions';
    cfg.harnesses.claude.env = { STUB_MODES: 'ask,auto' };
    await build(cfg);
    const task = await tasks.upsertMirrored(mirroredAfk(7));
    await startMirrored(task.id);

    const modeSet = await vi.waitFor(async () => {
      const event = (await eventsForTask(task.id)).find(
        (candidate) =>
          candidate.type === 'lifecycle' &&
          candidate.payload !== null &&
          typeof candidate.payload === 'object' &&
          !Array.isArray(candidate.payload) &&
          'event' in candidate.payload &&
          candidate.payload.event === 'mode_set',
      );
      if (!event) throw new Error('mode not set');
      return event;
    }, { timeout: 10_000 });

    expect(modeSet.payload).toMatchObject({
      mode: 'auto',
      requested: 'bypassPermissions',
      advertised: ['ask', 'auto'],
      applied: 'auto',
      fallbackReason: 'configured-mode-not-advertised',
    });
  });

  it('an afk Run visibly falls back when its default permission mode is not advertised', async () => {
    const cfg = config({ prompt: JSON.stringify({ echoSetMode: true }) });
    cfg.harnesses.claude.env = { STUB_MODES: 'ask,bypassPermissions' };
    await build(cfg);
    const task = await tasks.upsertMirrored(mirroredAfk(8));
    await startMirrored(task.id);

    const modeSet = await vi.waitFor(async () => {
      const event = (await eventsForTask(task.id)).find(
        (candidate) => candidate.type === 'lifecycle' && (candidate.payload as any).event === 'mode_set',
      );
      if (!event) throw new Error('mode not set');
      return event;
    }, { timeout: 10_000 });

    expect(modeSet.payload).toMatchObject({
      mode: 'bypassPermissions',
      requested: null,
      advertised: ['ask', 'bypassPermissions'],
      applied: 'bypassPermissions',
      fallbackReason: 'default-mode-not-advertised',
    });
  });

  it('an afk Run fails closed when the harness offers no unattended permission mode', async () => {
    const cfg = config({}, 1);
    cfg.harnesses.claude.env = { STUB_MODES: '' };
    await build(cfg);
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
    await build(config({ prompt: JSON.stringify({ exit: 'crash-before-response' }) }, 2));
    const task = await tasks.upsertMirrored(mirroredAfk(7));

    await startMirrored(task.id);
    const settled = await vi.waitFor(async () => {
      const t = await tasks.get(task.id);
      if (t.state !== 'escalated') throw new Error('not escalated yet');
      return t;
    }, { timeout: 10_000 });
    expect(settled.escalationReason).toMatch(/workflow attempts exhausted after 2/);
    const taskAttempts = await attempts.listForTask(task.id);
    expect(taskAttempts.map((attempt) => ({ number: attempt.number, state: attempt.state }))).toEqual([{ number: 1, state: 'escalated' }]);
  });

  it('markAgentFinished / markEscalate no-op (return false) when the Task is not working here', async () => {
    await build(config());
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
    const drive = new AutoDrive(() => null, async () => adapter);
    const task = worktreeTask({ trackerRef: trackerRef(7), workingDir: repo });
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
    const drive = new AutoDrive(() => null, async () => adapter);
    const task = worktreeTask({ trackerRef: trackerRef(7), workingDir: repo });

    expect(await drive.closeTicket(task)).toBe(true);
    const afterFirst = g('rev-list', '--count', 'HEAD');

    expect(await drive.closeTicket(task)).toBe(true);
    expect(g('rev-list', '--count', 'HEAD')).toBe(afterFirst);
    expect(await Git.isDirty(repo)).toBe(false);
  });

  it('fires onTicketClosed with the commit oid + changed paths for a file-backed tracker', async () => {
    const adapter = localMarkdownAdapter(join(repo, '.scratch'));
    const commits: ({ oid: string; paths: string[] } | null)[] = [];
    const drive = new AutoDrive(() => null, async () => adapter, undefined, undefined, (_task, commit) => commits.push(commit));
    const task = worktreeTask({ trackerRef: trackerRef(7), workingDir: repo });

    expect(await drive.closeTicket(task)).toBe(true);

    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ oid: g('rev-parse', 'HEAD'), paths: [join(repo, '.scratch/issues/07-fix.md')] });
  });

  it('fires onTicketCloseFailed, not onTicketClosed, when the adapter throws', async () => {
    const adapter = localMarkdownAdapter(join(repo, '.scratch'));
    adapter.close = async () => {
      throw new Error('locked by another process');
    };
    const closed: unknown[] = [];
    const failed: [string | null, string][] = [];
    const drive = new AutoDrive(
      () => null,
      async () => adapter,
      undefined,
      undefined,
      (task) => closed.push(task.trackerRef),
      (task, err) => failed.push([task.trackerRef, err instanceof Error ? err.message : String(err)]),
    );
    const task = worktreeTask({ trackerRef: trackerRef(7), workingDir: repo });

    expect(await drive.closeTicket(task)).toBe(false);

    expect(closed).toEqual([]);
    expect(failed).toEqual([['7', 'locked by another process']]);
  });
});
