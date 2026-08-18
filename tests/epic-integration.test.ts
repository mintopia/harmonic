import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { mirrorScan } from '../src/tracker/mirror.js';
import type { Ticket } from '../src/tracker/adapter.js';
import { EpicIntegrationCoordinator, integrationBranchName, type EpicGit } from '../src/execution/epic-integration.js';
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

describe('EpicIntegrationCoordinator.reconcile (issue #159)', () => {
  let dir: string;
  let db: Db;
  let tasks: TaskService;
  let wsId: number;
  const mscan = (tickets: Ticket[]) => mirrorScan(tasks, tickets, wsId);
  const baseOf = (ref: number) => tasks.list().find((t) => t.trackerRef === ref)?.baseBranch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-epic-'));
    db = openDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    wsId = allWorkspaces(db)()[0]!.id;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** An Epic ref 10 (a Spec) with two ready-for-agent member children 11, 12. */
  const epicTickets = (): Ticket[] => [
    ticket({ number: 10, title: 'Epic' }),
    ticket({ number: 11, parent: 10, labels: ['ready-for-agent'] }),
    ticket({ number: 12, parent: 10, labels: ['ready-for-agent'] }),
  ];

  it('creates one integration branch cut from the default branch and points ready members at it', async () => {
    const tickets = epicTickets();
    const mirrored = mscan(tickets);
    const git = new FakeGit([], 'develop');
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(tickets, mirrored);

    expect(git.created).toEqual(['epic/10']);
    expect(baseOf(11)).toBe('epic/10');
    expect(baseOf(12)).toBe('epic/10');
    // The Epic ticket's own mirrored Task is never retargeted.
    expect(baseOf(10)).toBeNull();
  });

  it('is idempotent across polls: reuses the existing branch, never re-creates', async () => {
    const tickets = epicTickets();
    const git = new FakeGit([], 'develop');
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(tickets, mscan(tickets));
    await coord.reconcile(tickets, mscan(tickets));

    expect(git.created).toEqual(['epic/10']); // created once, reused thereafter
    expect(baseOf(11)).toBe('epic/10');
  });

  it('creates no branch and sets no base branch when no Epic is derivable', async () => {
    const flat = [ticket({ number: 99, parent: null, labels: ['ready-for-agent'] })];
    const git = new FakeGit([], 'develop');
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(flat, mscan(flat));

    expect(git.created).toEqual([]);
    expect(git.symbolicBranchCalls).toBe(0); // never even resolves the default branch
    expect(baseOf(99)).toBeNull();
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

    await coord.reconcile(tickets, mscan(tickets));

    expect(git.created).toEqual(['epic/10']);
    expect(baseOf(11)).toBe('epic/10');
    expect(baseOf(12)).toBeNull(); // blocked ⇒ not yet retargeted
  });

  it('never overwrites the base branch of an already-spawned (running) member', async () => {
    const tickets = epicTickets();
    mscan(tickets);
    const m11 = tasks.list().find((t) => t.trackerRef === 11)!;
    tasks.setState(m11.id, 'running');
    // A fresh post-mirror snapshot carries the live 'running' state, as the poll
    // passes it (upsertMirrored keeps an already-spawned member running).
    const mirrored = tasks.list();
    const git = new FakeGit([], 'develop');
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(tickets, mirrored);

    // Branch still ensured (12 is ready), but the running member's base is frozen.
    expect(git.created).toEqual(['epic/10']);
    expect(baseOf(11)).toBeNull();
    expect(baseOf(12)).toBe('epic/10');
  });

  it('creates no branch for an Epic with an empty ready frontier', async () => {
    const tickets = [
      ticket({ number: 10, title: 'Epic' }),
      ticket({ number: 11, parent: 10, state: 'closed', closedAt: '2026-08-08T00:00:00Z' }),
    ];
    const git = new FakeGit([], 'develop');
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(tickets, mscan(tickets));

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

    await coord.reconcile(tickets, mscan(tickets));

    expect(git.created.sort()).toEqual(['epic/10', 'epic/20']);
    expect(baseOf(11)).toBe('epic/10');
    expect(baseOf(21)).toBe('epic/20');
  });

  it('defers (no branch, members stay gated) when HEAD is detached', async () => {
    const tickets = epicTickets();
    const mirrored = mscan(tickets);
    const git = new FakeGit([], null); // detached HEAD ⇒ symbolicBranch null
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(tickets, mirrored);

    // No durable Epic branch anchored on a transient detached OID.
    expect(git.created).toEqual([]);
    expect(baseOf(11)).toBeNull();
    // The member is still recognised as base-pending, so the pick gate holds it
    // rather than letting it fork from the wrong base.
    const m11 = tasks.list().find((t) => t.trackerRef === 11)!;
    expect(coord.awaitsBase(m11)).toBe(true);
  });

  it('awaitsBase gates only base-pending ready Epic members', async () => {
    const tickets = [
      ...epicTickets(),
      ticket({ number: 99, parent: null, labels: ['ready-for-agent'] }), // not an Epic member
    ];
    const mirrored = mscan(tickets);
    const git = new FakeGit([], 'develop');
    const coord = new EpicIntegrationCoordinator(tasks, dir, git);

    await coord.reconcile(tickets, mirrored);

    const m11 = tasks.list().find((t) => t.trackerRef === 11)!;
    const nonMember = tasks.list().find((t) => t.trackerRef === 99)!;
    const native = tasks.create({ prompt: 'native task' });
    expect(m11.baseBranch).toBe('epic/10');
    expect(coord.awaitsBase(m11)).toBe(false); // base set ⇒ gate open
    expect(coord.awaitsBase(nonMember)).toBe(false); // never an Epic member
    expect(coord.awaitsBase(native)).toBe(false); // native Task ⇒ never gated
  });
});

describe('EpicIntegrationCoordinator.retireIntegrationBranch (issue #159)', () => {
  let dir: string;
  let db: Db;
  let tasks: TaskService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-epic-retire-'));
    db = openDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
  let db: Db;
  let tasks: TaskService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-setbase-'));
    db = openDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sets the column and is an idempotent no-op when unchanged', () => {
    const t = tasks.create({ prompt: 'do a thing' });
    expect(t.baseBranch).toBeNull();

    const set = tasks.setBaseBranch(t.id, 'epic/7');
    expect(set.baseBranch).toBe('epic/7');

    // Unchanged ⇒ updatedAt is not churned.
    const before = tasks.get(t.id).updatedAt;
    const again = tasks.setBaseBranch(t.id, 'epic/7');
    expect(again.baseBranch).toBe('epic/7');
    expect(again.updatedAt).toBe(before);

    // Clearing back to inherit is a first-class edit.
    expect(tasks.setBaseBranch(t.id, null).baseBranch).toBeNull();
  });
});
