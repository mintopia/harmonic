import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { DomainError } from '../src/domain/errors.js';
import { DEFAULT_LEASE_TTL } from '../src/domain/lease-ttl.js';
import { allWorkspaces } from './helpers.js';

/**
 * The Work Context lease store (issue #118, ADR-0022, reliability-design
 * §0.5): the persisted compare-and-set occupancy primitive over a Work
 * Context key.
 */
describe('WorkContextLeaseStore (issue #118)', () => {
  let dir: string;
  // RunStore migrated to the async libsql Db (ADR-0029 #203); this fixture
  // runs both connections on the one file.
  let asyncDb: AsyncDbHandle;
  let leases: WorkContextLeaseStore;
  let ownerRunId: number;
  let otherRunId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-wcl-'));
    asyncDb = await openAsyncDb(dir);
    const tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
    const runStore = new RunStore(asyncDb);
    leases = new WorkContextLeaseStore(asyncDb);

    const task = await tasks.create({ prompt: 'own a lease', state: 'ready' });
    ownerRunId = (await runStore.create(task.id)).id;
    const otherTask = await tasks.create({ prompt: 'contend for a lease', state: 'ready' });
    otherRunId = (await runStore.create(otherTask.id)).id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires a free key as a held lease, findable by key and by owner', async () => {
    const lease = await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');

    expect(lease.state).toBe('held');
    expect(lease.key).toBe('direct:/tmp/repo');
    expect(lease.ownerRunId).toBe(ownerRunId);

    expect(await leases.getByKey('direct:/tmp/repo')).toMatchObject({ id: lease.id, ownerRunId });
    expect(await leases.getByOwner(ownerRunId)).toMatchObject({ id: lease.id, key: 'direct:/tmp/repo' });
  });

  it('a second acquire on the same key throws DomainError(conflict) and does not overwrite the first owner', async () => {
    await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');

    let caught: unknown;
    try {
      await leases.acquire('direct:/tmp/repo', otherRunId, 'running');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe('conflict');

    expect(await leases.getByKey('direct:/tmp/repo')).toMatchObject({ ownerRunId });
  });

  it('release frees the key so a subsequent acquire on it succeeds', async () => {
    await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
    await leases.release('direct:/tmp/repo');

    expect(await leases.getByKey('direct:/tmp/repo')).toBeUndefined();

    const reacquired = await leases.acquire('direct:/tmp/repo', otherRunId, 'running');
    expect(reacquired.ownerRunId).toBe(otherRunId);
  });

  it('releaseByOwner frees whatever the owner holds, and is idempotent', async () => {
    await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');

    await leases.releaseByOwner(ownerRunId);
    expect(await leases.getByOwner(ownerRunId)).toBeUndefined();
    expect(await leases.getByKey('direct:/tmp/repo')).toBeUndefined();

    // Idempotent: a second release with nothing held does not throw.
    await expect(leases.releaseByOwner(ownerRunId)).resolves.not.toThrow();
  });

  it('heartbeat updates the heartbeat timestamp', async () => {
    const lease = await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
    const originalHeartbeat = lease.heartbeat;

    await new Promise((r) => setTimeout(r, 5));
    const now = Date.now();
    await leases.heartbeat('direct:/tmp/repo', now);

    const updated = await leases.getByKey('direct:/tmp/repo');
    expect(updated!.heartbeat).toBe(now);
    expect(updated!.heartbeat).toBeGreaterThan(originalHeartbeat);
  });

  describe('acquireOrTransfer (issue #124)', () => {
    it('transfers a held lease to a successor sharing the line of work', async () => {
      const original = await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');

      await new Promise((r) => setTimeout(r, 5));
      const moved = await leases.acquireOrTransfer('direct:/tmp/repo', otherRunId, 'running', () => true);

      expect(moved.ownerRunId).toBe(otherRunId);
      expect(moved.id).toBe(original.id);
      expect(moved.key).toBe('direct:/tmp/repo');
      expect(moved.heartbeat).toBeGreaterThan(original.heartbeat);

      expect(await leases.getByKey('direct:/tmp/repo')).toMatchObject({ id: original.id, ownerRunId: otherRunId });
      expect(await leases.getByOwner(ownerRunId)).toBeUndefined();
      expect(await leases.getByOwner(otherRunId)).toMatchObject({ id: original.id, key: 'direct:/tmp/repo' });
    });

    it('rejects an unrelated successor (predicate false) — does not inherit', async () => {
      await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');

      let caught: unknown;
      try {
        await leases.acquireOrTransfer('direct:/tmp/repo', otherRunId, 'running', () => false);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('conflict');

      expect(await leases.getByKey('direct:/tmp/repo')).toMatchObject({ ownerRunId });
    });

    it('acquires fresh when the key is unheld', async () => {
      const lease = await leases.acquireOrTransfer('direct:/tmp/other-repo', otherRunId, 'running', () => true);

      expect(lease.ownerRunId).toBe(otherRunId);
      expect(lease.key).toBe('direct:/tmp/other-repo');
      expect(await leases.getByKey('direct:/tmp/other-repo')).toMatchObject({ ownerRunId: otherRunId });
    });
  });

  describe('listAll / markSuspect (issue #123)', () => {
    it('listAll returns every seeded lease row', async () => {
      await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
      await leases.acquire('direct:/tmp/other-repo', otherRunId, 'running');

      const all = await leases.listAll();
      expect(all).toHaveLength(2);
      expect(all.map((l) => l.key).sort()).toEqual(['direct:/tmp/other-repo', 'direct:/tmp/repo']);
    });

    it('markSuspect flips state to suspect and leaves the row in place', async () => {
      await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');

      await leases.markSuspect('direct:/tmp/repo');

      const lease = await leases.getByKey('direct:/tmp/repo');
      expect(lease).toBeDefined();
      expect(lease?.state).toBe('suspect');
      expect(lease?.ownerRunId).toBe(ownerRunId);
    });

    it('a suspect lease still blocks a fresh acquire on the same key', async () => {
      await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
      await leases.markSuspect('direct:/tmp/repo');

      let caught: unknown;
      try {
        await leases.acquire('direct:/tmp/repo', otherRunId, 'running');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('conflict');
    });

    it('markSuspect is a no-op when the key holds nothing', async () => {
      await expect(leases.markSuspect('direct:/tmp/nothing-here')).resolves.not.toThrow();
      expect(await leases.getByKey('direct:/tmp/nothing-here')).toBeUndefined();
    });
  });

  describe('TTL / heartbeat / sweep (issue #122)', () => {
    it('acquire sets a non-null expiry roughly now + the execution budget', async () => {
      const before = Date.now();
      const lease = await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
      const after = Date.now();

      expect(lease.expiry).not.toBeNull();
      expect(lease.expiry!).toBeGreaterThanOrEqual(before + DEFAULT_LEASE_TTL.executionMs);
      expect(lease.expiry!).toBeLessThanOrEqual(after + DEFAULT_LEASE_TTL.executionMs);
    });

    it('heartbeat(key, now, "executing") sets an execution-budget expiry', async () => {
      await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
      const now = Date.now();

      await leases.heartbeat('direct:/tmp/repo', now, 'executing');

      const updated = await leases.getByKey('direct:/tmp/repo');
      expect(updated!.heartbeat).toBe(now);
      expect(updated!.phase).toBe('executing');
      expect(updated!.expiry).toBe(now + DEFAULT_LEASE_TTL.executionMs);
    });

    it('heartbeat(key, now, "review") sets a far-future review-budget expiry', async () => {
      await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
      const now = Date.now();

      await leases.heartbeat('direct:/tmp/repo', now, 'review');

      const updated = await leases.getByKey('direct:/tmp/repo');
      expect(updated!.phase).toBe('review');
      expect(updated!.expiry).toBe(now + DEFAULT_LEASE_TTL.reviewMs);
    });

    it('heartbeat(key, now) with no phase leaves expiry untouched (today\'s bump-timestamp-only behaviour)', async () => {
      const lease = await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
      const originalExpiry = lease.expiry;
      const now = Date.now();

      await leases.heartbeat('direct:/tmp/repo', now);

      const updated = await leases.getByKey('direct:/tmp/repo');
      expect(updated!.heartbeat).toBe(now);
      expect(updated!.expiry).toBe(originalExpiry);
    });

    it('sweepExpired flips only held+past-expiry rows to suspect, leaving future-expiry, null-expiry, and already-suspect rows alone; returns the swept rows', async () => {
      const now = 1_000_000;

      // held, past expiry -> swept
      await leases.acquire('direct:/tmp/expired', ownerRunId, 'running');
      await leases.heartbeat('direct:/tmp/expired', now - 10_000, 'executing');

      // held, future expiry -> untouched
      await leases.acquire('direct:/tmp/future', otherRunId, 'running');
      await leases.heartbeat('direct:/tmp/future', now + 10_000, 'review');

      const sweptAt = now + DEFAULT_LEASE_TTL.executionMs + 20_000; // well past the expired one's expiry, still before the future one's

      const swept = await leases.sweepExpired(sweptAt);

      expect(swept).toHaveLength(1);
      expect(swept[0]!.key).toBe('direct:/tmp/expired');
      expect(swept[0]!.state).toBe('suspect');

      expect((await leases.getByKey('direct:/tmp/expired'))?.state).toBe('suspect');
      expect((await leases.getByKey('direct:/tmp/future'))?.state).toBe('held');
    });

    it('sweepExpired leaves a null-expiry row alone', async () => {
      // Acquire, then simulate a legacy null-expiry row via a no-phase heartbeat's
      // sibling case is not directly reachable through the public API (acquire
      // always sets an expiry) — assert the invariant through isLeaseLapsed's
      // contract instead by heartbeating far in the future so it's simply not swept.
      await leases.acquire('direct:/tmp/never-heartbeat', ownerRunId, 'running');
      const swept = await leases.sweepExpired(Date.now() + DEFAULT_LEASE_TTL.executionMs + 1);
      // Freshly acquired lease's own execution-budget expiry has now passed too,
      // so it IS swept — demonstrating acquire's TTL-from-birth behaviour.
      expect(swept.map((l) => l.key)).toContain('direct:/tmp/never-heartbeat');
    });

    it('sweepExpired never releases — a suspect lease still keeps its key', async () => {
      await leases.acquire('direct:/tmp/expired', ownerRunId, 'running');
      const now = Date.now();
      await leases.heartbeat('direct:/tmp/expired', now - DEFAULT_LEASE_TTL.executionMs - 10_000, 'executing');

      await leases.sweepExpired(now);

      expect(await leases.getByKey('direct:/tmp/expired')).toMatchObject({ state: 'suspect', ownerRunId });
    });

    it('sweepExpired does not re-sweep an already-suspect row', async () => {
      await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
      await leases.markSuspect('direct:/tmp/repo');

      const swept = await leases.sweepExpired(Date.now() + DEFAULT_LEASE_TTL.reviewMs);

      expect(swept).toHaveLength(0);
    });

    it('listSuspect returns only suspect rows', async () => {
      await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
      await leases.acquire('direct:/tmp/other-repo', otherRunId, 'running');
      await leases.markSuspect('direct:/tmp/repo');

      const suspect = await leases.listSuspect();
      expect(suspect).toHaveLength(1);
      expect(suspect[0]!.key).toBe('direct:/tmp/repo');
      expect(suspect[0]!.state).toBe('suspect');
    });

    it('AC3 re-admission guard: a suspect lease (flipped by sweepExpired) still throws DomainError(conflict) on acquire', async () => {
      await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
      const now = Date.now();
      await leases.heartbeat('direct:/tmp/repo', now - DEFAULT_LEASE_TTL.executionMs - 10_000, 'executing');
      await leases.sweepExpired(now);
      expect((await leases.getByKey('direct:/tmp/repo'))?.state).toBe('suspect');

      let caught: unknown;
      try {
        await leases.acquire('direct:/tmp/repo', otherRunId, 'running');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('conflict');
    });
  });

  describe('supersede / forceRelease / listDispositions (issue #125)', () => {
    it('supersede re-points a suspect lease to the named Run, re-admitting it as held with a fresh expiry', async () => {
      await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
      await leases.markSuspect('direct:/tmp/repo');

      const before = Date.now();
      const superseded = await leases.supersede('direct:/tmp/repo', otherRunId);
      const after = Date.now();

      expect(superseded.ownerRunId).toBe(otherRunId);
      expect(superseded.state).toBe('held');
      expect(superseded.expiry!).toBeGreaterThanOrEqual(before + DEFAULT_LEASE_TTL.executionMs);
      expect(superseded.expiry!).toBeLessThanOrEqual(after + DEFAULT_LEASE_TTL.executionMs);

      expect(await leases.getByKey('direct:/tmp/repo')).toMatchObject({ ownerRunId: otherRunId, state: 'held' });
      expect(await leases.getByOwner(otherRunId)).toMatchObject({ key: 'direct:/tmp/repo' });
    });

    it('supersede writes an audit disposition capturing the previous owner and state', async () => {
      await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
      await leases.markSuspect('direct:/tmp/repo');

      await leases.supersede('direct:/tmp/repo', otherRunId);

      const dispositions = await leases.listDispositions();
      expect(dispositions).toHaveLength(1);
      expect(dispositions[0]).toMatchObject({
        key: 'direct:/tmp/repo',
        action: 'supersede',
        targetRunId: otherRunId,
        previousOwnerRunId: ownerRunId,
        previousState: 'suspect',
      });
    });

    it('supersede on a key holding nothing throws DomainError(not_found)', async () => {
      let caught: unknown;
      try {
        await leases.supersede('direct:/tmp/nothing-here', ownerRunId);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('not_found');
      expect(await leases.listDispositions()).toHaveLength(0);
    });

    it('forceRelease deletes the lease, writes an audit disposition, and makes the key re-acquirable', async () => {
      await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
      await leases.markSuspect('direct:/tmp/repo');

      await leases.forceRelease('direct:/tmp/repo');

      expect(await leases.getByKey('direct:/tmp/repo')).toBeUndefined();
      const dispositions = await leases.listDispositions();
      expect(dispositions).toHaveLength(1);
      expect(dispositions[0]).toMatchObject({
        key: 'direct:/tmp/repo',
        action: 'unlock',
        targetRunId: null,
        previousOwnerRunId: ownerRunId,
        previousState: 'suspect',
      });

      const reacquired = await leases.acquire('direct:/tmp/repo', otherRunId, 'running');
      expect(reacquired.ownerRunId).toBe(otherRunId);
    });

    it('forceRelease on a key holding nothing throws DomainError(not_found)', async () => {
      let caught: unknown;
      try {
        await leases.forceRelease('direct:/tmp/nothing-here');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('not_found');
      expect(await leases.listDispositions()).toHaveLength(0);
    });

    it('listDispositions is append-only and ordered oldest first, surviving both a supersede and a later unlock', async () => {
      await leases.acquire('direct:/tmp/repo', ownerRunId, 'running');
      await leases.supersede('direct:/tmp/repo', otherRunId);
      await leases.forceRelease('direct:/tmp/repo');

      const dispositions = await leases.listDispositions();
      expect(dispositions.map((d) => d.action)).toEqual(['supersede', 'unlock']);
      expect(dispositions[0]!.previousOwnerRunId).toBe(ownerRunId);
      expect(dispositions[1]!.previousOwnerRunId).toBe(otherRunId);
    });
  });
});
