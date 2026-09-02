import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { mirrorScan } from '../src/tracker/mirror.js';
import { EPIC_LABEL, type Ticket } from '../src/tracker/adapter.js';
import {
  EpicLifecycle,
  integrationBranchName,
  parseIntegrationBranch,
  reduceMemberState,
  type EpicGit,
  type EpicIntegrateTrigger,
  type EpicRefreshTrigger,
} from '../src/execution/epic-coordinator.js';
import type { MemberMergeState } from '../src/domain/epic-integrate-decision.js';
import type { EpicRefreshOutcome } from '../src/execution/epic-coordinator.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

const ticket = (over: Partial<Ticket>): Ticket => ({
  number: 100,
  title: 'A ticket',
  state: 'open',
  body: '',
  createdAt: '2026-08-07T00:00:00Z',
  closedAt: null,
  labels: [],
  assignees: [],
  parent: null,
  blockedBy: [],
  blocking: [],
  comments: [],
  isMap: false,
  url: 'https://github.com/mintopia/harmonic/issues/100',
  ...over,
});

class FakeGit implements Pick<EpicGit, 'symbolicBranch' | 'branchExists' | 'createBranch' | 'deleteBranch' | 'branchCheckedOutAt' | 'isAncestor'> {
  readonly branches: Set<string>;
  readonly created: string[] = [];
  readonly deleted: string[] = [];
  readonly checkedOut = new Set<string>();
  readonly contained = new Set<string>();
  symbolicBranchCalls = 0;
  constructor(
    existing: string[] = [],
    private readonly defaultBranch: string | null = 'develop',
  ) {
    this.branches = new Set(existing);
    for (const branch of existing) this.contained.add(branch);
  }
  async symbolicBranch(): Promise<string | null> {
    this.symbolicBranchCalls++;
    return this.defaultBranch;
  }
  async branchExists(_dir: string, name: string): Promise<boolean> {
    return this.branches.has(name);
  }
  async createBranch(_dir: string, name: string, _startPoint: string): Promise<unknown> {
    if (this.branches.has(name)) throw new Error(`branch ${name} already exists`);
    this.branches.add(name);
    this.created.push(name);
    return undefined;
  }
  async deleteBranch(_dir: string, name: string): Promise<unknown> {
    this.branches.delete(name);
    this.deleted.push(name);
    return undefined;
  }
  async branchCheckedOutAt(_dir: string, branch: string): Promise<string | null> {
    return this.checkedOut.has(branch) ? '/worktree/active' : null;
  }
  async isAncestor(_dir: string, _baseBranch: string, branch: string): Promise<boolean> {
    return this.contained.has(branch);
  }
}

class FakeRefresh implements EpicRefreshTrigger {
  readonly calls: number[] = [];
  async refresh(target: { ref: number; repoDir: string; defaultBranch: string }): Promise<EpicRefreshOutcome> {
    this.calls.push(target.ref);
    return { status: 'refreshed' as const, oid: 'deadbeef' };
  }
}

describe('integrationBranchName', () => {
  it('names an Epic integration branch epic/<ref>', () => {
    expect(integrationBranchName(42)).toBe('epic/42');
  });
});

describe('parseIntegrationBranch (issue #163)', () => {
  it('recovers the Epic ref from an integration branch name — the exact inverse of integrationBranchName', () => {
    expect(parseIntegrationBranch(integrationBranchName(42))).toBe(42);
    expect(parseIntegrationBranch('epic/42')).toBe(42);
    expect(parseIntegrationBranch('epic/0')).toBe(0);
    expect(parseIntegrationBranch('epic/1000000')).toBe(1_000_000);
  });

  it('rejects anything that is not exactly epic/<digits>', () => {
    expect(parseIntegrationBranch('main')).toBeNull();
    expect(parseIntegrationBranch('epic/')).toBeNull();
    expect(parseIntegrationBranch('epic/x')).toBeNull();
    expect(parseIntegrationBranch('epic/1x')).toBeNull();
    expect(parseIntegrationBranch('epic/-1')).toBeNull();
    expect(parseIntegrationBranch('epic/1.5')).toBeNull();
    expect(parseIntegrationBranch('feature/epic/1')).toBeNull();
    expect(parseIntegrationBranch('epic/1/')).toBeNull();
    expect(parseIntegrationBranch('Epic/1')).toBeNull();
  });

  it('treats null/undefined/empty as "not an integration branch", never throwing', () => {
    expect(parseIntegrationBranch(null)).toBeNull();
    expect(parseIntegrationBranch(undefined)).toBeNull();
    expect(parseIntegrationBranch('')).toBeNull();
  });
});

describe('EpicLifecycle.reconcile (issue #159)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let wsId: number;
  const mscan = (tickets: Ticket[]) => mirrorScan(tasks, tickets, wsId);
  const baseOf = async (ref: number) => (await tasks.list()).find((t) => t.trackerRef === ref)?.baseBranch;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-epic-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    wsId = (await allWorkspaces(asyncDb, settingsStore)())[0]!.id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const epicTickets = (): Ticket[] => [
    ticket({ number: 10, title: 'Epic' }),
    ticket({ number: 11, parent: 10, labels: ['ready-for-agent'] }),
    ticket({ number: 12, parent: 10, labels: ['ready-for-agent'] }),
  ];

  it('creates one integration branch cut from the default branch and points ready members at it', async () => {
    const tickets = epicTickets();
    const mirrored = await mscan(tickets);
    const git = new FakeGit([], 'develop');
    const coord = new EpicLifecycle(tasks, dir, git);

    await coord.reconcile(tickets, mirrored);

    expect(git.created).toEqual(['epic/10']);
    expect(await baseOf(11)).toBe('epic/10');
    expect(await baseOf(12)).toBe('epic/10');
    expect(await baseOf(10)).toBeNull();
  });

  it('cuts an epic/<ref> branch for every kind — map, spec, and plain (ADR-0018, #438)', async () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec', labels: [EPIC_LABEL], body: '## What to build\n\nspec' }),
      ticket({ number: 11, parent: 10, labels: ['ready-for-agent'] }),
      ticket({ number: 20, title: 'Map', isMap: true, labels: ['wayfinder:map'] }),
      ticket({ number: 21, parent: 20, labels: ['ready-for-agent'] }),
      ticket({ number: 30, title: 'Plain' }),
      ticket({ number: 31, parent: 30, labels: ['ready-for-agent'] }),
    ];
    const git = new FakeGit([], 'develop');
    const coord = new EpicLifecycle(tasks, dir, git);

    await coord.reconcile(tickets, await mscan(tickets));

    expect([...git.created].sort()).toEqual(['epic/10', 'epic/20', 'epic/30']);
  });

  it('is idempotent across polls: reuses the existing branch, never re-creates', async () => {
    const tickets = epicTickets();
    const git = new FakeGit([], 'develop');
    const coord = new EpicLifecycle(tasks, dir, git);

    await coord.reconcile(tickets, await mscan(tickets));
    await coord.reconcile(tickets, await mscan(tickets));

    expect(git.created).toEqual(['epic/10']);
    expect(await baseOf(11)).toBe('epic/10');
  });

  it('creates no branch and sets no base branch when no Epic is derivable', async () => {
    const flat = [ticket({ number: 99, parent: null, labels: ['ready-for-agent'] })];
    const git = new FakeGit([], 'develop');
    const coord = new EpicLifecycle(tasks, dir, git);

    await coord.reconcile(flat, await mscan(flat));

    expect(git.created).toEqual([]);
    expect(git.symbolicBranchCalls).toBe(0);
    expect(await baseOf(99)).toBeNull();
  });

  it('retargets only the ready frontier, not blocked members', async () => {
    const tickets = [
      ticket({ number: 10, title: 'Epic' }),
      ticket({ number: 11, parent: 10, labels: ['ready-for-agent'] }),
      ticket({
        number: 12,
        parent: 10,
        labels: ['ready-for-agent'],
        blockedBy: [{ number: 11, title: 'member 11', state: 'open' }],
      }),
    ];
    const git = new FakeGit([], 'develop');
    const coord = new EpicLifecycle(tasks, dir, git);

    await coord.reconcile(tickets, await mscan(tickets));

    expect(git.created).toEqual(['epic/10']);
    expect(await baseOf(11)).toBe('epic/10');
    expect(await baseOf(12)).toBeNull();
  });

  it('never overwrites the base branch of an already-spawned (running) member', async () => {
    const tickets = epicTickets();
    await mscan(tickets);
    const m11 = (await tasks.list()).find((t) => t.trackerRef === 11)!;
    await tasks.setState(m11.id, 'working');
    const mirrored = await tasks.list();
    const git = new FakeGit([], 'develop');
    const coord = new EpicLifecycle(tasks, dir, git);

    await coord.reconcile(tickets, mirrored);

    expect(git.created).toEqual(['epic/10']);
    expect(await baseOf(11)).toBeNull();
    expect(await baseOf(12)).toBe('epic/10');
  });

  it('creates no branch for an Epic with an empty ready frontier', async () => {
    const tickets = [
      ticket({ number: 10, title: 'Epic' }),
      ticket({ number: 11, parent: 10, state: 'closed', closedAt: '2026-08-08T00:00:00Z' }),
    ];
    const git = new FakeGit([], 'develop');
    const coord = new EpicLifecycle(tasks, dir, git);

    await coord.reconcile(tickets, await mscan(tickets));

    expect(git.created).toEqual([]);
    expect(git.symbolicBranchCalls).toBe(0);
  });

  it('gives each Epic its own integration branch', async () => {
    const tickets = [
      ticket({ number: 10, title: 'Epic A' }),
      ticket({ number: 11, parent: 10, labels: ['ready-for-agent'] }),
      ticket({ number: 20, title: 'Epic B' }),
      ticket({ number: 21, parent: 20, labels: ['ready-for-agent'] }),
    ];
    const git = new FakeGit([], 'develop');
    const coord = new EpicLifecycle(tasks, dir, git);

    await coord.reconcile(tickets, await mscan(tickets));

    expect(git.created.sort()).toEqual(['epic/10', 'epic/20']);
    expect(await baseOf(11)).toBe('epic/10');
    expect(await baseOf(21)).toBe('epic/20');
  });

  it('defers (no branch, members stay gated) when HEAD is detached', async () => {
    const tickets = epicTickets();
    const mirrored = await mscan(tickets);
    const git = new FakeGit([], null);
    const coord = new EpicLifecycle(tasks, dir, git);

    await coord.reconcile(tickets, mirrored);

    expect(git.created).toEqual([]);
    expect(await baseOf(11)).toBeNull();
    const m11 = (await tasks.list()).find((t) => t.trackerRef === 11)!;
    expect(coord.awaitsBase(m11)).toBe(true);
  });

  it('awaitsBase gates only base-pending ready Epic members', async () => {
    const tickets = [
      ...epicTickets(),
      ticket({ number: 99, parent: null, labels: ['ready-for-agent'] }),
    ];
    const mirrored = await mscan(tickets);
    const git = new FakeGit([], 'develop');
    const coord = new EpicLifecycle(tasks, dir, git);

    await coord.reconcile(tickets, mirrored);

    const m11 = (await tasks.list()).find((t) => t.trackerRef === 11)!;
    const nonMember = (await tasks.list()).find((t) => t.trackerRef === 99)!;
    const native = await tasks.create({ prompt: 'native task' });
    expect(m11.baseBranch).toBe('epic/10');
    expect(coord.awaitsBase(m11)).toBe(false);
    expect(coord.awaitsBase(nonMember)).toBe(false);
    expect(coord.awaitsBase(native)).toBe(false);
  });

  it('memberBaseNotReady tracks git branch existence, open when epic/<ref> exists, gated when it is gone — and a detached HEAD does not gate an existing branch (#231)', async () => {
    const tickets = [
      ...epicTickets(),
      ticket({ number: 99, parent: null, labels: ['ready-for-agent'] }),
    ];
    const git = new FakeGit([], 'develop');
    const coord = new EpicLifecycle(tasks, dir, git);

    await coord.reconcile(tickets, await mscan(tickets));

    const m11 = async () => (await tasks.list()).find((t) => t.trackerRef === 11)!;
    const nonMember = (await tasks.list()).find((t) => t.trackerRef === 99)!;
    const native = await tasks.create({ prompt: 'native task' });
    expect((await m11()).baseBranch).toBe('epic/10');
    expect(await coord.memberBaseNotReady(await m11())).toBe(false);
    expect(await coord.memberBaseNotReady(nonMember)).toBe(false);
    expect(await coord.memberBaseNotReady(native)).toBe(false);

    const detached = new FakeGit(['epic/10'], null);
    const coordDetached = new EpicLifecycle(tasks, dir, detached);
    await coordDetached.reconcile(tickets, await mscan(tickets));
    expect(await coordDetached.memberBaseNotReady(await m11())).toBe(false);

    const gone = new EpicLifecycle(tasks, dir, new FakeGit([], 'develop'));
    expect(await gone.memberBaseNotReady(await m11())).toBe(true);
  });

  it('gates a recognised Epic member under an existing integration branch, even before any reconcile publishes the ready frontier (#334/#332)', async () => {
    const tickets = epicTickets();
    const mirrored = await mscan(tickets);
    const m11 = mirrored.find((t) => t.trackerRef === 11)!;
    expect(m11.mapRef).toBe(10);
    expect(m11.baseBranch).toBeNull();

    const coord = new EpicLifecycle(tasks, dir, new FakeGit(['epic/10'], 'develop'));
    expect(coord.awaitsBase(m11)).toBe(false);
    expect(await coord.memberBaseNotReady(m11)).toBe(true);
  });

  it('gates a leaf-Epic member before its integration branch is even cut, but never a spine parent’s child (pre-cut race, #334)', async () => {
    const spine = [
      ticket({ number: 1, title: 'Spine', isMap: true }),
      ticket({ number: 10, title: 'Leaf Epic', parent: 1 }),
      ticket({ number: 11, parent: 10, labels: ['ready-for-agent'] }),
      ticket({ number: 5, parent: 1, labels: ['ready-for-agent'] }),
    ];
    const mirrored = await mscan(spine);
    const m11 = mirrored.find((t) => t.trackerRef === 11)!;
    const m5 = mirrored.find((t) => t.trackerRef === 5)!;
    expect(m11.mapRef).toBe(10);
    expect(m5.mapRef).toBe(1);

    const coord = new EpicLifecycle(tasks, dir, new FakeGit([], 'develop'));
    expect(coord.awaitsBase(m11)).toBe(false);
    expect(await coord.memberBaseNotReady(m11)).toBe(true);
    expect(await coord.memberBaseNotReady(m5)).toBe(false);
  });

  it('a continuation/retry never regresses an Epic member to develop: a base flipped to develop/null re-gates on membership (#334/#330-331)', async () => {
    const tickets = epicTickets();
    const mirrored = await mscan(tickets);
    const coord = new EpicLifecycle(tasks, dir, new FakeGit([], 'develop'));
    await coord.reconcile(tickets, mirrored);

    const m11Id = mirrored.find((t) => t.trackerRef === 11)!.id;
    expect((await tasks.get(m11Id)).baseBranch).toBe('epic/10');
    expect(await coord.memberBaseNotReady(await tasks.get(m11Id))).toBe(false);

    const retryCoord = new EpicLifecycle(tasks, dir, new FakeGit(['epic/10'], 'develop'));
    for (const regressed of ['develop', null] as const) {
      await tasks.setBaseBranch(m11Id, regressed);
      const task = await tasks.get(m11Id);
      expect(retryCoord.awaitsBase(task)).toBe(false);
      expect(await retryCoord.memberBaseNotReady(task)).toBe(true);
    }
  });

  it('a member whose epic branch exists is spawnable even when the ready frontier is empty; a missing branch is deferred (#231)', async () => {
    const tickets = epicTickets();
    const mirrored = await mscan(tickets);
    const m11Id = mirrored.find((t) => t.trackerRef === 11)!.id;
    await tasks.setBaseBranch(m11Id, 'epic/10');
    const present = new EpicLifecycle(tasks, dir, new FakeGit(['epic/10'], 'develop'));
    expect(await present.memberBaseNotReady(await tasks.get(m11Id))).toBe(false);

    const missing = new EpicLifecycle(tasks, dir, new FakeGit([], 'develop'));
    expect(await missing.memberBaseNotReady(await tasks.get(m11Id))).toBe(true);
  });

  it('level-triggered currency: a poll refreshes a behind epic/<ref> (develop advanced by a non-merge path) and skips a current one', async () => {
    const tickets = epicTickets();
    const mirrored = await mscan(tickets);
    const git = new FakeGit(['epic/10'], 'develop');
    git.contained.delete('epic/10');
    const refresh = new FakeRefresh();
    const coord = new EpicLifecycle(tasks, dir, git);
    coord.attachRefreshTrigger(refresh);

    await coord.reconcile(tickets, mirrored);
    expect(refresh.calls).toEqual([10]);

    git.contained.add('epic/10');
    refresh.calls.length = 0;
    await coord.reconcile(tickets, await mscan(tickets));
    expect(refresh.calls).toEqual([]);
  });

  it('refreshes a behind epic even with an empty ready frontier (currency is not gated by the ready-frontier early return)', async () => {
    const tickets = [
      ticket({ number: 10, title: 'Epic' }),
      ticket({ number: 11, parent: 10, state: 'closed', closedAt: '2026-08-08T00:00:00Z' }),
    ];
    const git = new FakeGit(['epic/10'], 'develop');
    git.contained.delete('epic/10');
    const refresh = new FakeRefresh();
    const coord = new EpicLifecycle(tasks, dir, git);
    coord.attachRefreshTrigger(refresh);

    await coord.reconcile(tickets, await mscan(tickets));
    expect(refresh.calls).toEqual([10]);
  });

  it('never refreshes an epic whose integration branch does not exist, and skips currency on a detached HEAD', async () => {
    const tickets = epicTickets();
    const noBranch = new FakeGit([], 'develop');
    const r1 = new FakeRefresh();
    const c1 = new EpicLifecycle(tasks, dir, noBranch);
    c1.attachRefreshTrigger(r1);
    await c1.reconcile(tickets, await mscan(tickets));
    expect(r1.calls).toEqual([]);

    const detached = new FakeGit(['epic/10'], null);
    detached.contained.delete('epic/10');
    const r2 = new FakeRefresh();
    const c2 = new EpicLifecycle(tasks, dir, detached);
    c2.attachRefreshTrigger(r2);
    await c2.reconcile(tickets, await mscan(tickets));
    expect(r2.calls).toEqual([]);
  });
});

describe('reduceMemberState (issue #161)', () => {
  const row = (over: Partial<{ state: string; escalated: boolean }>) =>
    ({ state: 'ready', escalated: false, ...over }) as never;
  it('maps a done member Task to completed', () => {
    expect(reduceMemberState(row({ state: 'done' }))).toBe('completed');
  });
  it('maps an escalated / failed / cancelled member to blocked', () => {
    expect(reduceMemberState(row({ state: 'escalated' }))).toBe('blocked');
    expect(reduceMemberState(row({ state: 'cancelled' }))).toBe('blocked');
  });
  it('maps everything else (and a missing Task) to pending', () => {
    expect(reduceMemberState(row({ state: 'working' }))).toBe('pending');
    expect(reduceMemberState(undefined)).toBe('pending');
  });
});

describe('EpicLifecycle whole-Epic integrate trigger (issue #161)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let wsId: number;
  const mscan = (tickets: Ticket[]) => mirrorScan(tasks, tickets, wsId);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-epic-integrate-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    wsId = (await allWorkspaces(asyncDb, settingsStore)())[0]!.id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  class FakeIntegrate implements EpicIntegrateTrigger {
    readonly calls: { ref: number; members: MemberMergeState[]; force: boolean }[] = [];
    async submit(target: { ref: number; members: MemberMergeState[] }, opts?: { force?: boolean }) {
      this.calls.push({ ref: target.ref, members: target.members, force: opts?.force ?? false });
      return { status: 'noop' as const };
    }
  }

  const epicTickets = (): Ticket[] => [
    ticket({ number: 10, title: 'Epic' }),
    ticket({ number: 11, parent: 10, labels: ['ready-for-agent'] }),
    ticket({ number: 12, parent: 10, labels: ['ready-for-agent'] }),
  ];
  const memberTaskId = async (ref: number) => (await tasks.list()).find((t) => t.trackerRef === ref)!.id;

  it('offers each derived Epic for an integrate attempt with its members reduced from live Task state', async () => {
    const tickets = epicTickets();
    const mirrored = await mscan(tickets);
    const git = new FakeGit(['epic/10'], 'develop');
    const trigger = new FakeIntegrate();
    const coord = new EpicLifecycle(tasks, dir, git);
    coord.attachIntegrateTrigger(trigger);
    await tasks.setState(await memberTaskId(11), 'done');
    await tasks.setState(await memberTaskId(12), 'done');

    await coord.reconcile(tickets, mirrored);

    expect(trigger.calls).toEqual([{ ref: 10, members: ['completed', 'completed'], force: false }]);
  });

  it('reduces an escalated member to blocked in the integrate attempt', async () => {
    const tickets = epicTickets();
    const mirrored = await mscan(tickets);
    const git = new FakeGit(['epic/10'], 'develop');
    const trigger = new FakeIntegrate();
    const coord = new EpicLifecycle(tasks, dir, git);
    coord.attachIntegrateTrigger(trigger);
    await tasks.setState(await memberTaskId(11), 'done');
    await tasks.escalate(await memberTaskId(12), 'escalated to human: attempt 2 of 2 failed');

    await coord.reconcile(tickets, mirrored);

    expect(trigger.calls).toHaveLength(1);
    expect(trigger.calls[0]!.members.slice().sort()).toEqual(['blocked', 'completed']);
  });

  it('runs the integrate pass even with an empty ready frontier (all members completed)', async () => {
    const tickets = epicTickets();
    const mirrored = await mscan(tickets);
    const git = new FakeGit(['epic/10'], 'develop');
    const trigger = new FakeIntegrate();
    const coord = new EpicLifecycle(tasks, dir, git);
    coord.attachIntegrateTrigger(trigger);
    await tasks.setState(await memberTaskId(11), 'done');
    await tasks.setState(await memberTaskId(12), 'done');

    await coord.reconcile(tickets, mirrored);
    expect(trigger.calls).toHaveLength(1);
  });
});

describe('EpicLifecycle.retireIntegrationBranch (issue #159)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-epic-retire-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('deletes the branch when it exists and is idempotent when it is already gone', async () => {
    const git = new FakeGit(['epic/10']);
    const coord = new EpicLifecycle(tasks, dir, git);

    await coord.retireIntegrationBranch(10);
    expect(git.deleted).toEqual(['epic/10']);

    await coord.retireIntegrationBranch(10);
    expect(git.deleted).toEqual(['epic/10']);
  });

  it('keeps an uncontained or checked-out integration branch', async () => {
    const git = new FakeGit(['epic/10']);
    git.contained.delete('epic/10');
    const coord = new EpicLifecycle(tasks, dir, git);

    await coord.retireIntegrationBranch(10);
    expect(git.deleted).toEqual([]);

    git.contained.add('epic/10');
    git.checkedOut.add('epic/10');
    await coord.retireIntegrationBranch(10);
    expect(git.deleted).toEqual([]);
  });
});

describe('TaskService.setBaseBranch (issue #159)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-setbase-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sets the column and is an idempotent no-op when unchanged', async () => {
    const t = await tasks.create({ prompt: 'do a thing' });
    expect(t.baseBranch).toBeNull();

    const set = await tasks.setBaseBranch(t.id, 'epic/7');
    expect(set.baseBranch).toBe('epic/7');

    const before = (await tasks.get(t.id)).updatedAt;
    const again = await tasks.setBaseBranch(t.id, 'epic/7');
    expect(again.baseBranch).toBe('epic/7');
    expect(again.updatedAt).toBe(before);

    expect((await tasks.setBaseBranch(t.id, null)).baseBranch).toBeNull();
  });
});
