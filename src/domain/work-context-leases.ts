import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { workContextLeases, type WorkContextLeaseRow } from '../db/schema.js';
import { DomainError } from './errors.js';

/** Matches better-sqlite3's message for a violated UNIQUE constraint, as a
 * fallback when the driver's `.code` isn't populated (e.g. wrapped errors). */
const UNIQUE_VIOLATION_MESSAGE = /UNIQUE constraint failed/;

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || UNIQUE_VIOLATION_MESSAGE.test(err.message);
}

/**
 * The Work Context lease store (issue #118, ADR-0022, reliability-design
 * §0.5): persists exclusive occupancy claims over a `workContextKey`. The
 * `work_context_leases_key_unique` index is the compare-and-set acquire
 * primitive — `acquire` relies on the database to reject a second row for an
 * already-held (or suspect) key rather than racing a select-then-insert.
 *
 * Scope is deliberately narrow: this is the persisted substrate only. Nothing
 * here calls into the Runner, enforces TTLs (#122), or reconciles a `suspect`
 * lease (#123) — those are separate tickets.
 */
export class WorkContextLeaseStore {
  constructor(private readonly db: Db) {}

  /**
   * Acquire a lease on `key` for `ownerRunId`. Throws `DomainError('conflict')`
   * if the key is already held (or suspect) — the existing row is left
   * untouched.
   */
  acquire(key: string, ownerRunId: number, phase: string): WorkContextLeaseRow {
    const now = Date.now();
    try {
      return this.db
        .insert(workContextLeases)
        .values({ key, phase, ownerRunId, heartbeat: now, expiry: null, state: 'held', acquiredAt: now })
        .returning()
        .get();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DomainError('conflict', `Work Context lease already held for key "${key}"`);
      }
      throw err;
    }
  }

  /** Frees `key`; a no-op if nothing holds it. */
  release(key: string): void {
    this.db.delete(workContextLeases).where(eq(workContextLeases.key, key)).run();
  }

  /** Frees whatever `ownerRunId` holds, if anything; idempotent. */
  releaseByOwner(ownerRunId: number): void {
    this.db.delete(workContextLeases).where(eq(workContextLeases.ownerRunId, ownerRunId)).run();
  }

  /** Bumps the liveness heartbeat on `key`'s lease, if one exists. */
  heartbeat(key: string, now: number = Date.now()): void {
    this.db.update(workContextLeases).set({ heartbeat: now }).where(eq(workContextLeases.key, key)).run();
  }

  getByKey(key: string): WorkContextLeaseRow | undefined {
    return this.db.select().from(workContextLeases).where(eq(workContextLeases.key, key)).get();
  }

  getByOwner(ownerRunId: number): WorkContextLeaseRow | undefined {
    return this.db.select().from(workContextLeases).where(eq(workContextLeases.ownerRunId, ownerRunId)).get();
  }
}
