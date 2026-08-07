import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig, type AppConfig } from '../src/config.js';
import { TaskService, type MirrorInput } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { Runner } from '../src/execution/runner.js';
import { AutoDrive, buildDrivePrompt, skillFor, splitTitleBody } from '../src/execution/auto-drive.js';
import type { TaskRow, RunRow } from '../src/db/schema.js';
import type { Ticket, TrackerAdapter, OpenPRInput } from '../src/tracker/adapter.js';

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
  const calls = { close: [] as number[], openPR: [] as OpenPRInput[], read: [] as number[] };
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
    openPR: async (input) => {
      calls.openPR.push(input);
    },
  };
  return { adapter, calls };
}

const okGit = { merge: async () => ({ ok: true as const }) } as any;
const conflictGit = { merge: async () => ({ ok: false as const, detail: 'CONFLICT' }) } as any;

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
      drive: { prompt: '{skill} {ref} {url}\n\n{title}::{body}', mergeFate: 'auto-merge', autoRetry: 1 },
    };
    const research = worktreeTask({ trackerRef: 9, wayfinderType: 'research', prompt: 'Investigate X\n\nwhy' });
    const drive = new AutoDrive(() => config, (ref) => (ref === 9 ? 'https://x/9' : null));
    expect(drive.prompt(research)).toBe('/research 9 https://x/9\n\nInvestigate X::why');
  });
});

describe('AutoDrive.onFailed — Auto-Retry cap (issue #33)', () => {
  const cfg = (autoRetry: number): AppConfig => ({
    ...defaultConfig(),
    drive: { prompt: '', mergeFate: 'auto-merge', autoRetry },
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

describe('AutoDrive.onCompleted — Merge Fate + fallback-close (issue #33)', () => {
  const cfg = (mergeFate: AppConfig['drive']['mergeFate']): AppConfig => ({
    ...defaultConfig(),
    drive: { prompt: '', mergeFate, autoRetry: 1 },
  });

  it('auto-merge (default): merges then fallback-closes', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const drive = new AutoDrive(() => cfg('auto-merge'), () => null, async () => adapter, okGit);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('completed');
    expect(calls.close).toEqual([7]);
  });

  it('auto-merge conflict escalates — branch left, ticket untouched', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const drive = new AutoDrive(() => cfg('auto-merge'), () => null, async () => adapter, conflictGit);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('escalate');
    expect(calls.close).toEqual([]);
  });

  it('open-PR opens a PR and leaves the issue open for off-Harmonic review; no merge, no close', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const merge = vi.fn();
    const drive = new AutoDrive(() => cfg('open-PR'), () => null, async () => adapter, { merge } as any);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('completed');
    expect(merge).not.toHaveBeenCalled();
    expect(calls.openPR).toHaveLength(1);
    expect(calls.openPR[0]).toMatchObject({ branch: 'harmonic/task-1-run-1', baseBranch: 'main' });
    expect(calls.close).toEqual([]); // the PR's own merge closes the issue, not Harmonic
  });

  it('open-PR that fails to create a PR escalates — the issue is not closed over stranded work', async () => {
    const { adapter, calls } = fakeAdapter('open');
    adapter.openPR = async () => {
      throw new Error('no push permission');
    };
    const drive = new AutoDrive(() => cfg('open-PR'), () => null, async () => adapter, okGit);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('escalate');
    expect(calls.close).toEqual([]);
  });

  it('open-PR degrades to artifact when the tracker has no PR capability: leave branch, close', async () => {
    const { adapter, calls } = fakeAdapter('open');
    delete adapter.openPR;
    const drive = new AutoDrive(() => cfg('open-PR'), () => null, async () => adapter, okGit);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('completed');
    expect(calls.close).toEqual([7]);
  });

  it('artifact leaves the branch, just closes', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const merge = vi.fn();
    const drive = new AutoDrive(() => cfg('artifact'), () => null, async () => adapter, { merge } as any);
    expect(await drive.onCompleted(worktreeTask(), run())).toBe('completed');
    expect(merge).not.toHaveBeenCalled();
    expect(calls.openPR).toEqual([]);
    expect(calls.close).toEqual([7]);
  });

  it('research is always an artifact, even under an auto-merge default', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const merge = vi.fn();
    const drive = new AutoDrive(() => cfg('auto-merge'), () => null, async () => adapter, { merge } as any);
    expect(await drive.onCompleted(worktreeTask({ wayfinderType: 'research' }), run())).toBe('completed');
    expect(merge).not.toHaveBeenCalled();
    expect(calls.close).toEqual([7]);
  });

  it('fallback-close is a fallback: an already-closed ticket is not re-closed', async () => {
    const { adapter, calls } = fakeAdapter('closed');
    const drive = new AutoDrive(() => cfg('artifact'), () => null, async () => adapter, okGit);
    await drive.onCompleted(worktreeTask(), run());
    expect(calls.close).toEqual([]);
  });

  it('direct mode has no branch: just fallback-closes', async () => {
    const { adapter, calls } = fakeAdapter('open');
    const merge = vi.fn();
    const drive = new AutoDrive(() => cfg('auto-merge'), () => null, async () => adapter, { merge } as any);
    await drive.onCompleted(worktreeTask({ isolationMode: 'direct' }), run({ branch: null, baseBranch: null }));
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
    drive: { prompt: '{skill} #{ref}', mergeFate: 'auto-merge', autoRetry: 1, ...over },
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

  function build(cfg: AppConfig) {
    tasks = new TaskService(db, () => cfg);
    runs = new RunStore(db);
    const drive = new AutoDrive(() => cfg, () => 'https://x/7', async () => fakeAdapter('open').adapter, okGit);
    runner = new Runner(runs, tasks, () => cfg, { autoDrive: drive });
  }

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
});
