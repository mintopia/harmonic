import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { DomainError } from '../src/domain/errors.js';
import { allWorkspaces } from './helpers.js';

/**
 * The Work Context lease store (issue #118, ADR-0022, reliability-design
 * §0.5): the persisted compare-and-set occupancy primitive over a Work
 * Context key.
 */
describe('WorkContextLeaseStore (issue #118)', () => {
  let dir: string;
  let db: Db;
  let leases: WorkContextLeaseStore;
  let ownerRunId: number;
  let otherRunId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-wcl-'));
    db = openDb(dir);
    const tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    const runStore = new RunStore(db);
    leases = new WorkContextLeaseStore(db);

    const task = tasks.create({ prompt: 'own a lease', state: 'ready' });
    ownerRunId = runStore.create(task.id).id;
    const otherTask = tasks.create({ prompt: 'contend for a lease', state: 'ready' });
    otherRunId = runStore.create(otherTask.id).id;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('acquires a free key as a held lease, findable by key and by owner', () => {
    const lease = leases.acquire('direct:/tmp/repo', ownerRunId, 'running');

    expect(lease.state).toBe('held');
    expect(lease.key).toBe('direct:/tmp/repo');
    expect(lease.ownerRunId).toBe(ownerRunId);

    expect(leases.getByKey('direct:/tmp/repo')).toMatchObject({ id: lease.id, ownerRunId });
    expect(leases.getByOwner(ownerRunId)).toMatchObject({ id: lease.id, key: 'direct:/tmp/repo' });
  });

  it('a second acquire on the same key throws DomainError(conflict) and does not overwrite the first owner', () => {
    leases.acquire('direct:/tmp/repo', ownerRunId, 'running');

    let caught: unknown;
    try {
      leases.acquire('direct:/tmp/repo', otherRunId, 'running');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe('conflict');

    expect(leases.getByKey('direct:/tmp/repo')).toMatchObject({ ownerRunId });
  });

  it('release frees the key so a subsequent acquire on it succeeds', () => {
    leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
    leases.release('direct:/tmp/repo');

    expect(leases.getByKey('direct:/tmp/repo')).toBeUndefined();

    const reacquired = leases.acquire('direct:/tmp/repo', otherRunId, 'running');
    expect(reacquired.ownerRunId).toBe(otherRunId);
  });

  it('releaseByOwner frees whatever the owner holds, and is idempotent', () => {
    leases.acquire('direct:/tmp/repo', ownerRunId, 'running');

    leases.releaseByOwner(ownerRunId);
    expect(leases.getByOwner(ownerRunId)).toBeUndefined();
    expect(leases.getByKey('direct:/tmp/repo')).toBeUndefined();

    // Idempotent: a second release with nothing held does not throw.
    expect(() => leases.releaseByOwner(ownerRunId)).not.toThrow();
  });

  it('heartbeat updates the heartbeat timestamp', async () => {
    const lease = leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
    const originalHeartbeat = lease.heartbeat;

    await new Promise((r) => setTimeout(r, 5));
    const now = Date.now();
    leases.heartbeat('direct:/tmp/repo', now);

    const updated = leases.getByKey('direct:/tmp/repo');
    expect(updated!.heartbeat).toBe(now);
    expect(updated!.heartbeat).toBeGreaterThan(originalHeartbeat);
  });

  describe('acquireOrTransfer (issue #124)', () => {
    it('transfers a held lease to a successor sharing the line of work', async () => {
      const original = leases.acquire('direct:/tmp/repo', ownerRunId, 'running');

      await new Promise((r) => setTimeout(r, 5));
      const moved = leases.acquireOrTransfer('direct:/tmp/repo', otherRunId, 'running', () => true);

      expect(moved.ownerRunId).toBe(otherRunId);
      expect(moved.id).toBe(original.id);
      expect(moved.key).toBe('direct:/tmp/repo');
      expect(moved.heartbeat).toBeGreaterThan(original.heartbeat);

      expect(leases.getByKey('direct:/tmp/repo')).toMatchObject({ id: original.id, ownerRunId: otherRunId });
      expect(leases.getByOwner(ownerRunId)).toBeUndefined();
      expect(leases.getByOwner(otherRunId)).toMatchObject({ id: original.id, key: 'direct:/tmp/repo' });
    });

    it('rejects an unrelated successor (predicate false) — does not inherit', () => {
      leases.acquire('direct:/tmp/repo', ownerRunId, 'running');

      let caught: unknown;
      try {
        leases.acquireOrTransfer('direct:/tmp/repo', otherRunId, 'running', () => false);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('conflict');

      expect(leases.getByKey('direct:/tmp/repo')).toMatchObject({ ownerRunId });
    });

    it('acquires fresh when the key is unheld', () => {
      const lease = leases.acquireOrTransfer('direct:/tmp/other-repo', otherRunId, 'running', () => true);

      expect(lease.ownerRunId).toBe(otherRunId);
      expect(lease.key).toBe('direct:/tmp/other-repo');
      expect(leases.getByKey('direct:/tmp/other-repo')).toMatchObject({ ownerRunId: otherRunId });
    });
  });

  describe('listAll / markSuspect (issue #123)', () => {
    it('listAll returns every seeded lease row', () => {
      leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
      leases.acquire('direct:/tmp/other-repo', otherRunId, 'running');

      const all = leases.listAll();
      expect(all).toHaveLength(2);
      expect(all.map((l) => l.key).sort()).toEqual(['direct:/tmp/other-repo', 'direct:/tmp/repo']);
    });

    it('markSuspect flips state to suspect and leaves the row in place', () => {
      leases.acquire('direct:/tmp/repo', ownerRunId, 'running');

      leases.markSuspect('direct:/tmp/repo');

      const lease = leases.getByKey('direct:/tmp/repo');
      expect(lease).toBeDefined();
      expect(lease?.state).toBe('suspect');
      expect(lease?.ownerRunId).toBe(ownerRunId);
    });

    it('a suspect lease still blocks a fresh acquire on the same key', () => {
      leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
      leases.markSuspect('direct:/tmp/repo');

      let caught: unknown;
      try {
        leases.acquire('direct:/tmp/repo', otherRunId, 'running');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('conflict');
    });

    it('markSuspect is a no-op when the key holds nothing', () => {
      expect(() => leases.markSuspect('direct:/tmp/nothing-here')).not.toThrow();
      expect(leases.getByKey('direct:/tmp/nothing-here')).toBeUndefined();
    });
  });
});
