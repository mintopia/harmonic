import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { mirrorScan } from '../src/tracker/mirror.js';
import type { Ticket } from '../src/tracker/adapter.js';
import {
  EpicIntegrationCoordinator,
  integrationBranchName,
  parseIntegrationBranch,
  reduceMemberState,
  type EpicGit,
  type EpicLandTrigger,
} from '../src/execution/epic-integration.js';
import type { MemberLandState } from '../src/domain/epic-land.js';
import { allWorkspaces } from './helpers.js';

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

/** An in-memory {@link EpicGit} recording create/delete and answering existence from a set. */
class FakeGit implements EpicGit {
  readonly branches: Set<string>;
  readonly created: string[] = [];
  readonly deleted: string[] = [];
  symbolicBranchCalls = 0;
  constructor(
    existing: string[] = [],
    /** null ⇒ detached HEAD. */
    private readonly defaultBranch: string | null = 'develop',
  ) {
    this.branches = new Set(existing);
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
    expect(parseIntegrationBranch('Epic/1')).toBeNull(); // case-sensitive
  });

  it('treats null/undefined/empty as "not an integration branch", never throwing', () => {
    expect(parseIntegrationBranch(null)).toBeNull();
    expect(parseIntegrationBranch(undefined)).toBeNull();
    expect(parseIntegrationBranch('')).toBeNull();
  });
});

describe('EpicIntegrationCoordinator.reconcile (issue #159)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let wsId: number;
  const mscan = (tickets: Ticket[]) => mirrorScan(tasks, tickets, wsId);
  const baseOf = async (ref: number) => (await tasks.list()).find((t) => t.trackerRef === ref)?.baseBranch;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-epic-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
    wsId = (await allWorkspaces(asyncDb)())[0]!.id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** An Epic ref 10 (a Spec) with two ready-for-agent member children 11, 12. */
  const epicTickets = (): Ticket[] => [
    ticket({ number: 10, title: 'Epic' }),
    ticket({ number: 11, parent: 10, labels: ['ready-for-agent'] }),
    ticket({ number: 12, parent: 10, labels: ['ready-for-agent'] }),
  ];

  it('creates one integration branch cut from the default branch and points ready members at it', async () => {
    const tickets = epicTickets();
    const mirrored = await mscan(tickets);
    const git = new FakeGit([], 'develop');
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(tickets, mirrored);

    expect(git.created).toEqual(['epic/10']);
    expect(await baseOf(11)).toBe('epic/10');
    expect(await baseOf(12)).toBe('epic/10');
    // The Epic ticket's own mirrored Task is never retargeted.
    expect(await baseOf(10)).toBeNull();
  });

  it('is idempotent across polls: reuses the existing branch, never re-creates', async () => {
    const tickets = epicTickets();
    const git = new FakeGit([], 'develop');
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(tickets, await mscan(tickets));
    await coord.reconcile(tickets, await mscan(tickets));

    expect(git.created).toEqual(['epic/10']); // created once, reused thereafter
    expect(await baseOf(11)).toBe('epic/10');
  });

  it('creates no branch and sets no base branch when no Epic is derivable', async () => {
    const flat = [ticket({ number: 99, parent: null, labels: ['ready-for-agent'] })];
    const git = new FakeGit([], 'develop');
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(flat, await mscan(flat));

    expect(git.created).toEqual([]);
    expect(git.symbolicBranchCalls).toBe(0); // never even resolves the default branch
    expect(await baseOf(99)).toBeNull();
  });

  it('retargets only the ready frontier, not blocked members', async () => {
    // 12 is blocked by open ticket 11, so it is not in the ready frontier.
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
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(tickets, await mscan(tickets));

    expect(git.created).toEqual(['epic/10']);
    expect(await baseOf(11)).toBe('epic/10');
    expect(await baseOf(12)).toBeNull(); // blocked ⇒ not yet retargeted
  });

  it('never overwrites the base branch of an already-spawned (running) member', async () => {
    const tickets = epicTickets();
    await mscan(tickets);
    const m11 = (await tasks.list()).find((t) => t.trackerRef === 11)!;
    await tasks.setState(m11.id, 'running');
    // A fresh post-mirror snapshot carries the live 'running' state, as the poll
    // passes it (upsertMirrored keeps an already-spawned member running).
    const mirrored = await tasks.list();
    const git = new FakeGit([], 'develop');
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(tickets, mirrored);

    // Branch still ensured (12 is ready), but the running member's base is frozen.
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
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

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
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(tickets, await mscan(tickets));

    expect(git.created.sort()).toEqual(['epic/10', 'epic/20']);
    expect(await baseOf(11)).toBe('epic/10');
    expect(await baseOf(21)).toBe('epic/20');
  });

  it('defers (no branch, members stay gated) when HEAD is detached', async () => {
    const tickets = epicTickets();
    const mirrored = await mscan(tickets);
    const git = new FakeGit([], null); // detached HEAD ⇒ symbolicBranch null
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(tickets, mirrored);

    // No durable Epic branch anchored on a transient detached OID.
    expect(git.created).toEqual([]);
    expect(await baseOf(11)).toBeNull();
    // The member is still recognised as base-pending, so the pick gate holds it
    // rather than letting it fork from the wrong base.
    const m11 = (await tasks.list()).find((t) => t.trackerRef === 11)!;
    expect(coord.awaitsBase(m11)).toBe(true);
  });

  it('awaitsBase gates only base-pending ready Epic members', async () => {
    const tickets = [
      ...epicTickets(),
      ticket({ number: 99, parent: null, labels: ['ready-for-agent'] }), // not an Epic member
    ];
    const mirrored = await mscan(tickets);
    const git = new FakeGit([], 'develop');
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(tickets, mirrored);

    const m11 = (await tasks.list()).find((t) => t.trackerRef === 11)!;
    const nonMember = (await tasks.list()).find((t) => t.trackerRef === 99)!;
    const native = await tasks.create({ prompt: 'native task' });
    expect(m11.baseBranch).toBe('epic/10');
    expect(coord.awaitsBase(m11)).toBe(false); // base set ⇒ gate open
    expect(coord.awaitsBase(nonMember)).toBe(false); // never an Epic member
    expect(coord.awaitsBase(native)).toBe(false); // native Task ⇒ never gated
  });

  it('memberBaseNotReady opens once the reconcile confirms the base branch live, closes when a later poll cannot', async () => {
    const tickets = [
      ...epicTickets(),
      ticket({ number: 99, parent: null, labels: ['ready-for-agent'] }), // not an Epic member
    ];
    const git = new FakeGit([], 'develop');
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(tickets, await mscan(tickets));

    const m11 = async () => (await tasks.list()).find((t) => t.trackerRef === 11)!;
    const nonMember = (await tasks.list()).find((t) => t.trackerRef === 99)!;
    const native = await tasks.create({ prompt: 'native task' });
    // Base set to epic/10 and the reconcile confirmed that branch live ⇒ open.
    expect((await m11()).baseBranch).toBe('epic/10');
    expect(coord.memberBaseNotReady(await m11())).toBe(false);
    expect(coord.memberBaseNotReady(nonMember)).toBe(false); // ordinary Task base
    expect(coord.memberBaseNotReady(native)).toBe(false); // native ⇒ never gated

    // The working dir goes detached (a concurrent afk-direct Run): this poll
    // confirms nothing live, so the durable epic/10 base is no longer vouched for
    // and the member is gated rather than allowed to fork off a branch we can't
    // guarantee is there.
    const detached = new FakeGit(['epic/10'], null);
    const coordDetached = new EpicIntegrationCoordinator(tasks, dir, detached);
    await coordDetached.reconcile(tickets, await mscan(tickets));
    expect(coordDetached.memberBaseNotReady(await m11())).toBe(true);
  });

  it('memberBaseNotReady gates every member before the first reconcile confirms any branch live', async () => {
    const tickets = epicTickets();
    const mirrored = await mscan(tickets);
    // Point member 11 at epic/10 directly, as a durable base surviving a restart,
    // without ever running a reconcile (liveIntegrationRefs still empty).
    const m11Id = mirrored.find((t) => t.trackerRef === 11)!.id;
    await tasks.setBaseBranch(m11Id, 'epic/10');
    const git = new FakeGit(['epic/10'], 'develop');
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);
    // No reconcile has run: the branch may exist on disk, but this coordinator
    // has confirmed nothing, so it fails closed and gates the member.
    expect(coord.memberBaseNotReady(await tasks.get(m11Id))).toBe(true);
  });
});

describe('reduceMemberState (issue #161)', () => {
  const row = (over: Partial<{ state: string; escalated: boolean }>) =>
    ({ state: 'ready', escalated: false, ...over }) as never;
  it('maps a completed member Task to completed', () => {
    expect(reduceMemberState(row({ state: 'completed' }))).toBe('completed');
  });
  it('maps an escalated / failed / cancelled member to blocked', () => {
    expect(reduceMemberState(row({ state: 'ready', escalated: true }))).toBe('blocked');
    expect(reduceMemberState(row({ state: 'failed' }))).toBe('blocked');
    expect(reduceMemberState(row({ state: 'cancelled' }))).toBe('blocked');
  });
  it('maps everything else (and a missing Task) to pending', () => {
    expect(reduceMemberState(row({ state: 'running' }))).toBe('pending');
    expect(reduceMemberState(row({ state: 'awaiting-review' }))).toBe('pending');
    expect(reduceMemberState(undefined)).toBe('pending');
  });
});

describe('EpicIntegrationCoordinator whole-Epic land trigger (issue #161)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let wsId: number;
  const mscan = (tickets: Ticket[]) => mirrorScan(tasks, tickets, wsId);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-epic-land-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
    wsId = (await allWorkspaces(asyncDb)())[0]!.id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  class FakeLand implements EpicLandTrigger {
    readonly calls: { ref: number; members: MemberLandState[]; force: boolean }[] = [];
    async submit(target: { ref: number; members: MemberLandState[] }, opts?: { force?: boolean }) {
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

  it('offers each derived Epic for a land attempt with its members reduced from live Task state', async () => {
    const tickets = epicTickets();
    const mirrored = await mscan(tickets);
    const git = new FakeGit(['epic/10'], 'develop');
    const land = new FakeLand();
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);
    coord.attachLandTrigger(land);
    // Both members have landed onto the integration branch (Task state completed).
    await tasks.setState(await memberTaskId(11), 'completed');
    await tasks.setState(await memberTaskId(12), 'completed');

    await coord.reconcile(tickets, mirrored);

    expect(land.calls).toEqual([{ ref: 10, members: ['completed', 'completed'], force: false }]);
  });

  it('reduces an escalated member to blocked in the land attempt', async () => {
    const tickets = epicTickets();
    const mirrored = await mscan(tickets);
    const git = new FakeGit(['epic/10'], 'develop');
    const land = new FakeLand();
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);
    coord.attachLandTrigger(land);
    await tasks.setState(await memberTaskId(11), 'completed');
    await tasks.escalate(await memberTaskId(12)); // a member that cannot land

    await coord.reconcile(tickets, mirrored);

    expect(land.calls).toHaveLength(1);
    expect(land.calls[0]!.members.slice().sort()).toEqual(['blocked', 'completed']);
  });

  it('runs the land pass even with an empty ready frontier (all members completed)', async () => {
    const tickets = epicTickets();
    const mirrored = await mscan(tickets);
    const git = new FakeGit(['epic/10'], 'develop');
    const land = new FakeLand();
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);
    coord.attachLandTrigger(land);
    await tasks.setState(await memberTaskId(11), 'completed');
    await tasks.setState(await memberTaskId(12), 'completed');

    await coord.reconcile(tickets, mirrored);
    expect(land.calls).toHaveLength(1); // the empty-ready early return no longer fires with a trigger attached
  });
});

describe('EpicIntegrationCoordinator.retireIntegrationBranch (issue #159)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-epic-retire-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('deletes the branch when it exists and is idempotent when it is already gone', async () => {
    const git = new FakeGit(['epic/10']);
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.retireIntegrationBranch(10);
    expect(git.deleted).toEqual(['epic/10']);

    await coord.retireIntegrationBranch(10); // already gone ⇒ no-op
    expect(git.deleted).toEqual(['epic/10']);
  });
});

describe('TaskService.setBaseBranch (issue #159)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-setbase-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
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

    // Unchanged ⇒ updatedAt is not churned.
    const before = (await tasks.get(t.id)).updatedAt;
    const again = await tasks.setBaseBranch(t.id, 'epic/7');
    expect(again.baseBranch).toBe('epic/7');
    expect(again.updatedAt).toBe(before);

    // Clearing back to inherit is a first-class edit.
    expect((await tasks.setBaseBranch(t.id, null)).baseBranch).toBeNull();
  });
});
