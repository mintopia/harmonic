import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { SessionStore, type DispatchSessionInput } from '../src/domain/sessions.js';
import { SessionRetirementCoordinator } from '../src/domain/session-retirement-coordinator.js';
import type { RetentionConfig } from '../src/domain/session-retirement.js';
import type { RunRow } from '../src/db/schema.js';
import { allWorkspaces } from './helpers.js';

/**
 * Session retirement store transitions + coordinator (issue #148,
 * reliability-design Unit C): Session retirement is the sole owner of
 * builder-worktree removal, coordinated with the Work Context lease.
 */
describe('Session retirement (issue #148)', () => {
  let dir: string;
  let db: Db;
  // RunStore migrated to the async libsql Db (ADR-0029 #203); this fixture
  // runs both connections on the one file.
  let asyncDb: AsyncDbHandle;
  let sessions: SessionStore;
  let runs: RunStore;
  let leases: WorkContextLeaseStore;
  let tasks: TaskService;
  let workspaceId: number;
  const now = 1_000_000;
  const cfg: RetentionConfig = { rejectContinuationMs: 5_000, retentionTtlMs: 100_000 };

  const dispatch = (overrides: Partial<DispatchSessionInput> = {}) =>
    sessions.recordDispatch({
      harness: 'claude',
      harnessSessionId: 'sess-1',
      model: 'm',
      cwd: '/tmp/work',
      workspaceId,
      mcpTemplates: [],
      capabilities: undefined,
      adapterVersion: 'claude@1',
      now,
      ...overrides,
    });

  /** A running Run bound to `sessionRowId`. */
  const runForSession = async (sessionRowId: number): Promise<RunRow> => {
    const task = tasks.create({ prompt: 'p', state: 'ready' });
    const run = await runs.create(task.id);
    return runs.update(run.id, { sessionRowId });
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-retire-'));
    db = openDb(dir);
    asyncDb = await openAsyncDb(dir);
    sessions = new SessionStore(db);
    runs = new RunStore(asyncDb);
    leases = new WorkContextLeaseStore(db);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    workspaceId = allWorkspaces(db)()[0]!.id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('SessionStore transitions', () => {
    it('binds the builder worktree it owns', () => {
      const s = dispatch();
      const bound = sessions.bindWorktree(s.id, '/repo', '/wt/run-1', now);
      expect(bound).toMatchObject({ worktreePath: '/wt/run-1', worktreeRepoDir: '/repo' });
    });

    it('markIdle sets the deadline + pending reason; beginRetiring then clears the deadline', () => {
      const s = dispatch();
      const idle = sessions.markIdle(s.id, now + 5_000, 'reject-continuation-timeout', now);
      expect(idle).toMatchObject({ status: 'idle', retireDeadline: now + 5_000, retireReason: 'reject-continuation-timeout' });
      const retiring = sessions.beginRetiring(s.id, 'reject-continuation-timeout', now);
      expect(retiring).toMatchObject({ status: 'retiring', retireDeadline: null });
    });

    it('markRetired stamps retiredAt and is terminal', () => {
      const s = dispatch();
      sessions.beginRetiring(s.id, 'landed', now);
      const retired = sessions.markRetired(s.id, now + 1);
      expect(retired).toMatchObject({ status: 'retired', retiredAt: now + 1 });
    });

    it('never walks a retiring/retired Session back to idle', () => {
      const s = dispatch();
      sessions.beginRetiring(s.id, 'landed', now);
      const stuck = sessions.markIdle(s.id, now + 5_000, 'retention-ttl', now);
      expect(stuck.status).toBe('retiring'); // markIdle was a no-op
    });

    it('reactivate returns an idle Session to active for a continuation', () => {
      const s = dispatch();
      sessions.markIdle(s.id, now + 5_000, 'reject-continuation-timeout', now);
      const active = sessions.reactivate(s.id, now + 1);
      expect(active).toMatchObject({ status: 'active', retireDeadline: null, retireReason: null });
    });

    it('listRetiring / listRetentionDue select the right rows', () => {
      const a = dispatch({ harnessSessionId: 'a' });
      const b = dispatch({ harnessSessionId: 'b' });
      const c = dispatch({ harnessSessionId: 'c' });
      sessions.beginRetiring(a.id, 'landed', now);
      sessions.markIdle(b.id, now + 10, 'retention-ttl', now); // not yet due at `now`
      sessions.markIdle(c.id, now - 10, 'retention-ttl', now); // overdue
      expect(sessions.listRetiring().map((s) => s.id)).toEqual([a.id]);
      expect(sessions.listRetentionDue(now).map((s) => s.id)).toEqual([c.id]);
    });
  });

  describe('onRunSettled — the sync settle-hook', () => {
    const makeCoord = (removeWorktree = vi.fn(async () => {})) =>
      new SessionRetirementCoordinator(sessions, runs, leases, removeWorktree, cfg, () => now);

    it('marks the Session retiring on a landed disposition', async () => {
      const s = dispatch();
      const run = await runForSession(s.id);
      makeCoord().onRunSettled(run, 'landed', now);
      expect(sessions.get(s.id)).toMatchObject({ status: 'retiring', retireReason: 'landed' });
    });

    it('marks the Session idle under the reject-continuation deadline on a reject', async () => {
      const s = dispatch();
      const run = await runForSession(s.id);
      makeCoord().onRunSettled(run, 'rejected', now);
      expect(sessions.get(s.id)).toMatchObject({
        status: 'idle',
        retireReason: 'reject-continuation-timeout',
        retireDeadline: now + cfg.rejectContinuationMs,
      });
    });

    it('retires immediately on review-SLA and operator-cancel', async () => {
      const a = dispatch({ harnessSessionId: 'a' });
      const b = dispatch({ harnessSessionId: 'b' });
      makeCoord().onRunSettled(await runForSession(a.id), 'review-sla', now);
      makeCoord().onRunSettled(await runForSession(b.id), 'operator-cancel', now);
      expect(sessions.get(a.id)).toMatchObject({ status: 'retiring', retireReason: 'review-abandonment-sla' });
      expect(sessions.get(b.id)).toMatchObject({ status: 'retiring', retireReason: 'operator-disposition' });
    });

    it('retains under the retention-TTL backstop on any other ending', async () => {
      const s = dispatch();
      makeCoord().onRunSettled(await runForSession(s.id), 'other', now);
      expect(sessions.get(s.id)).toMatchObject({ status: 'idle', retireReason: 'retention-ttl', retireDeadline: now + cfg.retentionTtlMs });
    });

    it('is a no-op for a Run with no Session', async () => {
      const task = tasks.create({ prompt: 'p', state: 'ready' });
      const run = await runs.create(task.id); // sessionRowId null
      expect(() => makeCoord().onRunSettled(run, 'landed', now)).not.toThrow();
    });

    it('does not re-decide a Session already retiring', async () => {
      const s = dispatch();
      const run = await runForSession(s.id);
      const coord = makeCoord();
      coord.onRunSettled(run, 'landed', now);
      coord.onRunSettled(run, 'rejected', now + 1); // later reject must not un-retire it
      expect(sessions.get(s.id).status).toBe('retiring');
    });
  });

  describe('drain — the async removal pass (sole worktree remover)', () => {
    it('removes a retiring Session\'s worktree and marks it retired', async () => {
      const s = dispatch();
      sessions.bindWorktree(s.id, '/repo', '/wt/run-1', now);
      sessions.beginRetiring(s.id, 'landed', now);
      const removeWorktree = vi.fn(async () => {});
      const coord = new SessionRetirementCoordinator(sessions, runs, leases, removeWorktree, cfg, () => now);

      const retired = await coord.drain(now);

      expect(retired).toBe(1);
      expect(removeWorktree).toHaveBeenCalledWith('/repo', '/wt/run-1');
      expect(sessions.get(s.id)).toMatchObject({ status: 'retired', retiredAt: now });
    });

    it('sweeps an idle Session past its retention deadline, then removes + retires it', async () => {
      const s = dispatch();
      sessions.bindWorktree(s.id, '/repo', '/wt/run-1', now);
      sessions.markIdle(s.id, now, 'retention-ttl', now);
      const removeWorktree = vi.fn(async () => {});
      const coord = new SessionRetirementCoordinator(sessions, runs, leases, removeWorktree, cfg, () => now);

      await coord.drain(now + 1);

      expect(removeWorktree).toHaveBeenCalledOnce();
      expect(sessions.get(s.id).status).toBe('retired');
    });

    it('does NOT remove a worktree a live Run still leases (coordinated with the lease)', async () => {
      const s = dispatch();
      sessions.bindWorktree(s.id, '/repo', '/wt/run-1', now);
      const run = await runForSession(s.id);
      leases.acquire('worktree:/wt/run-1::branch', run.id, 'running'); // still held
      sessions.beginRetiring(s.id, 'landed', now);
      const removeWorktree = vi.fn(async () => {});
      const coord = new SessionRetirementCoordinator(sessions, runs, leases, removeWorktree, cfg, () => now);

      const retired = await coord.drain(now);

      expect(retired).toBe(0);
      expect(removeWorktree).not.toHaveBeenCalled();
      expect(sessions.get(s.id).status).toBe('retiring'); // left for a later drain

      // Once the lease releases, a later drain completes the retirement.
      leases.releaseByOwner(run.id);
      await coord.drain(now + 1);
      expect(removeWorktree).toHaveBeenCalledOnce();
      expect(sessions.get(s.id).status).toBe('retired');
    });

    it('retires a Session with no bound worktree as a pure status transition (nothing to remove)', async () => {
      const s = dispatch();
      sessions.beginRetiring(s.id, 'operator-disposition', now);
      const removeWorktree = vi.fn(async () => {});
      const coord = new SessionRetirementCoordinator(sessions, runs, leases, removeWorktree, cfg, () => now);

      await coord.drain(now);

      expect(removeWorktree).not.toHaveBeenCalled();
      expect(sessions.get(s.id).status).toBe('retired');
    });

    it('is idempotent — a second drain changes nothing and removes nothing again', async () => {
      const s = dispatch();
      sessions.bindWorktree(s.id, '/repo', '/wt/run-1', now);
      sessions.beginRetiring(s.id, 'landed', now);
      const removeWorktree = vi.fn(async () => {});
      const coord = new SessionRetirementCoordinator(sessions, runs, leases, removeWorktree, cfg, () => now);

      await coord.drain(now);
      await coord.drain(now);

      expect(removeWorktree).toHaveBeenCalledOnce();
      expect(sessions.get(s.id).status).toBe('retired');
    });

    it('survives a worktree-removal failure (best-effort) and still retires', async () => {
      const s = dispatch();
      sessions.bindWorktree(s.id, '/repo', '/wt/run-1', now);
      sessions.beginRetiring(s.id, 'landed', now);
      const removeWorktree = vi.fn(async () => {
        throw new Error('worktree already gone');
      });
      const coord = new SessionRetirementCoordinator(sessions, runs, leases, removeWorktree, cfg, () => now);

      await expect(coord.drain(now)).resolves.toBe(1);
      expect(sessions.get(s.id).status).toBe('retired');
    });
  });

  describe('lease transfer (continuation substrate)', () => {
    it('re-points a lease from one Run to the next sharing the Session', async () => {
      const s = dispatch();
      const first = await runForSession(s.id);
      const second = await runForSession(s.id);
      leases.acquire('worktree:/wt/run-1::branch', first.id, 'running');

      const moved = leases.transfer(first.id, second.id, now);

      expect(moved).toMatchObject({ ownerRunId: second.id });
      expect(leases.getByOwner(first.id)).toBeUndefined();
      expect(leases.getByOwner(second.id)).toMatchObject({ key: 'worktree:/wt/run-1::branch' });
    });
  });
});
