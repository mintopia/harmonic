import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { SessionStore, type DispatchSessionInput } from '../src/domain/sessions.js';
import { SessionRetirementCoordinator } from '../src/domain/session-retirement-coordinator.js';
import type { RetentionConfig } from '../src/domain/session-retirement.js';
import type { AttemptRow } from '../src/db/schema.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

/**
 * Session retirement store transitions + coordinator (issue #148,
 * reliability-design Unit C): Session retirement is the sole owner of
 * builder-worktree removal, gated on the Session having no active Run.
 */
describe('Session retirement (issue #148)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let sessions: SessionStore;
  let runs: AttemptStore;
  let tasks: TaskService;
  let workspaceId: number;
  const now = 1_000_000;
  const cfg: RetentionConfig = { retentionTtlMs: 100_000 };

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
  const runForSession = async (sessionRowId: number): Promise<AttemptRow> => {
    const task = await tasks.create({ prompt: 'p', state: 'ready' });
    const run = await runs.create(task.id);
    return runs.update(run.id, { sessionRowId });
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-retire-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    sessions = new SessionStore(asyncDb);
    runs = new AttemptStore(asyncDb);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    workspaceId = (await allWorkspaces(asyncDb, settingsStore)())[0]!.id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('SessionStore transitions', () => {
    it('binds the builder worktree it owns', async () => {
      const s = await dispatch();
      const bound = await sessions.bindWorktree(s.id, '/repo', '/wt/run-1', now);
      expect(bound).toMatchObject({ worktreePath: '/wt/run-1', worktreeRepoDir: '/repo' });
    });

    it('markIdle sets the deadline + pending reason; beginRetiring then clears the deadline', async () => {
      const s = await dispatch();
      const idle = await sessions.markIdle(s.id, now + 5_000, 'retention-ttl', now);
      expect(idle).toMatchObject({ status: 'idle', retireDeadline: now + 5_000, retireReason: 'retention-ttl' });
      const retiring = await sessions.beginRetiring(s.id, 'retention-ttl', now);
      expect(retiring).toMatchObject({ status: 'retiring', retireDeadline: null });
    });

    it('markRetired stamps retiredAt and is terminal', async () => {
      const s = await dispatch();
      await sessions.beginRetiring(s.id, 'merged', now);
      const retired = await sessions.markRetired(s.id, now + 1);
      expect(retired).toMatchObject({ status: 'retired', retiredAt: now + 1 });
    });

    it('never walks a retiring/retired Session back to idle', async () => {
      const s = await dispatch();
      await sessions.beginRetiring(s.id, 'merged', now);
      const stuck = await sessions.markIdle(s.id, now + 5_000, 'retention-ttl', now);
      expect(stuck.status).toBe('retiring'); // markIdle was a no-op
    });

    it('reactivate returns an idle Session to active for a continuation', async () => {
      const s = await dispatch();
      await sessions.markIdle(s.id, now + 5_000, 'retention-ttl', now);
      const active = await sessions.reactivate(s.id, now + 1);
      expect(active).toMatchObject({ status: 'active', retireDeadline: null, retireReason: null });
    });

    it('listRetiring / listRetentionDue select the right rows', async () => {
      const a = await dispatch({ harnessSessionId: 'a' });
      const b = await dispatch({ harnessSessionId: 'b' });
      const c = await dispatch({ harnessSessionId: 'c' });
      await sessions.beginRetiring(a.id, 'merged', now);
      await sessions.markIdle(b.id, now + 10, 'retention-ttl', now); // not yet due at `now`
      await sessions.markIdle(c.id, now - 10, 'retention-ttl', now); // overdue
      expect((await sessions.listRetiring()).map((s) => s.id)).toEqual([a.id]);
      expect((await sessions.listRetentionDue(now)).map((s) => s.id)).toEqual([c.id]);
    });
  });

  describe('onAttemptSettled — the sync settle-hook', () => {
    const makeCoord = (removeWorktree = vi.fn(async () => {})) =>
      new SessionRetirementCoordinator(sessions, runs, removeWorktree, cfg, () => now);

    it('marks the Session retiring on a merged disposition', async () => {
      const s = await dispatch();
      const run = await runForSession(s.id);
      await makeCoord().onAttemptSettled(run, 'merged', now);
      expect(await sessions.get(s.id)).toMatchObject({ status: 'retiring', retireReason: 'merged' });
    });

    it('retires immediately on an operator cancel (the Close action)', async () => {
      const b = await dispatch({ harnessSessionId: 'b' });
      await makeCoord().onAttemptSettled(await runForSession(b.id), 'operator-cancel', now);
      expect(await sessions.get(b.id)).toMatchObject({ status: 'retiring', retireReason: 'operator-disposition' });
    });

    it('retains under the retention-TTL backstop on any other ending', async () => {
      const s = await dispatch();
      await makeCoord().onAttemptSettled(await runForSession(s.id), 'other', now);
      expect(await sessions.get(s.id)).toMatchObject({ status: 'idle', retireReason: 'retention-ttl', retireDeadline: now + (cfg.retentionTtlMs ?? 0) });
    });

    it('is a no-op for a Run with no Session', async () => {
      const task = await tasks.create({ prompt: 'p', state: 'ready' });
      const run = await runs.create(task.id); // sessionRowId null
      await expect(makeCoord().onAttemptSettled(run, 'merged', now)).resolves.toBeUndefined();
    });

    it('does not re-decide a Session already retiring', async () => {
      const s = await dispatch();
      const run = await runForSession(s.id);
      const coord = makeCoord();
      await coord.onAttemptSettled(run, 'merged', now);
      await coord.onAttemptSettled(run, 'other', now + 1); // a later ending must not un-retire it
      expect((await sessions.get(s.id)).status).toBe('retiring');
    });
  });

  describe('drain — the async removal pass (sole worktree remover)', () => {
    it('removes a retiring Session\'s worktree and marks it retired', async () => {
      const s = await dispatch();
      await sessions.bindWorktree(s.id, '/repo', '/wt/run-1', now);
      await sessions.beginRetiring(s.id, 'merged', now);
      const removeWorktree = vi.fn(async () => {});
      const coord = new SessionRetirementCoordinator(sessions, runs, removeWorktree, cfg, () => now);

      const retired = await coord.drain(now);

      expect(retired).toBe(1);
      expect(removeWorktree).toHaveBeenCalledWith('/repo', '/wt/run-1');
      expect(await sessions.get(s.id)).toMatchObject({ status: 'retired', retiredAt: now });
    });

    it('sweeps an idle Session past its retention deadline, then removes + retires it', async () => {
      const s = await dispatch();
      await sessions.bindWorktree(s.id, '/repo', '/wt/run-1', now);
      await sessions.markIdle(s.id, now, 'retention-ttl', now);
      const removeWorktree = vi.fn(async () => {});
      const coord = new SessionRetirementCoordinator(sessions, runs, removeWorktree, cfg, () => now);

      await coord.drain(now + 1);

      expect(removeWorktree).toHaveBeenCalledOnce();
      expect((await sessions.get(s.id)).status).toBe('retired');
    });

    it('does NOT remove a worktree a live Run is still executing in', async () => {
      const s = await dispatch();
      await sessions.bindWorktree(s.id, '/repo', '/wt/run-1', now);
      const run = await runForSession(s.id); // still 'running'
      await sessions.beginRetiring(s.id, 'merged', now);
      const removeWorktree = vi.fn(async () => {});
      const coord = new SessionRetirementCoordinator(sessions, runs, removeWorktree, cfg, () => now);

      const retired = await coord.drain(now);

      expect(retired).toBe(0);
      expect(removeWorktree).not.toHaveBeenCalled();
      expect((await sessions.get(s.id)).status).toBe('retiring'); // left for a later drain

      // Once the Run leaves 'running', a later drain completes the retirement.
      await runs.update(run.id, { state: 'passed' });
      await coord.drain(now + 1);
      expect(removeWorktree).toHaveBeenCalledOnce();
      expect((await sessions.get(s.id)).status).toBe('retired');
    });

    it('retires a Session with no bound worktree as a pure status transition (nothing to remove)', async () => {
      const s = await dispatch();
      await sessions.beginRetiring(s.id, 'operator-disposition', now);
      const removeWorktree = vi.fn(async () => {});
      const coord = new SessionRetirementCoordinator(sessions, runs, removeWorktree, cfg, () => now);

      await coord.drain(now);

      expect(removeWorktree).not.toHaveBeenCalled();
      expect((await sessions.get(s.id)).status).toBe('retired');
    });

    it('is idempotent — a second drain changes nothing and removes nothing again', async () => {
      const s = await dispatch();
      await sessions.bindWorktree(s.id, '/repo', '/wt/run-1', now);
      await sessions.beginRetiring(s.id, 'merged', now);
      const removeWorktree = vi.fn(async () => {});
      const coord = new SessionRetirementCoordinator(sessions, runs, removeWorktree, cfg, () => now);

      await coord.drain(now);
      await coord.drain(now);

      expect(removeWorktree).toHaveBeenCalledOnce();
      expect((await sessions.get(s.id)).status).toBe('retired');
    });

    it('survives a worktree-removal failure (best-effort) and still retires', async () => {
      const s = await dispatch();
      await sessions.bindWorktree(s.id, '/repo', '/wt/run-1', now);
      await sessions.beginRetiring(s.id, 'merged', now);
      const removeWorktree = vi.fn(async () => {
        throw new Error('worktree already gone');
      });
      const coord = new SessionRetirementCoordinator(sessions, runs, removeWorktree, cfg, () => now);

      await expect(coord.drain(now)).resolves.toBe(1);
      expect((await sessions.get(s.id)).status).toBe('retired');
    });
  });
});
