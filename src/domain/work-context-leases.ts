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

  /**
   * Transactionally transfer whatever `fromRunId` holds to `toRunId` (issue
   * #148, reliability-design §0.5): re-points the lease's owner from one Run to
   * the next continuation Run sharing the same Session (retry / reject
   * continuation), so the builder worktree keeps exactly one owner across the
   * handover — the worktree is never left ownerless (which would let retirement
   * remove it out from under the continuation) nor doubly-claimed. A no-op if
   * `fromRunId` holds nothing. Returns the transferred lease, or undefined.
   *
   * Substrate only: no production caller performs a continuation handover yet
   * (the reject-continuation Run is a later ticket). Retirement's live lease
   * coordination today is the passive gate in `SessionRetirementCoordinator.drain`
   * — it never removes a worktree while any Run of the Session still holds a
   * lease; this is the transactional primitive that gate is built to survive. */
  transfer(fromRunId: number, toRunId: number, now: number = Date.now()): WorkContextLeaseRow | undefined {
    return this.db
      .update(workContextLeases)
      .set({ ownerRunId: toRunId, heartbeat: now })
      .where(eq(workContextLeases.ownerRunId, fromRunId))
      .returning()
      .get();
  }

  /**
   * Claim `key` for `ownerRunId`, transferring it instead of conflicting when
   * the current holder is a predecessor `sharesLineOfWork` recognizes as the
   * same line of work (issue #124, reliability-design §0.5): a successor Run
   * (retry / reject-continue / crash-resume / self-heal) beginning into a Work
   * Context still held by its own predecessor inherits the lease rather than
   * throwing a conflict.
   *
   * `key` is never momentarily unowned nor doubly-owned across the handoff:
   * `transfer` is a single UPDATE re-pointing `ownerRunId` (the row, and its
   * `id`, are unchanged), and `acquire` is a single INSERT guarded by the
   * unique-key CAS — exactly one of the two runs, never both, ever holds the
   * row. The predecessor's release is subsumed by the transfer; there is no
   * separate free.
   *
   * When the predicate returns false — an unrelated holder — this falls
   * through to `acquire`, which still hits the unique-key CAS and throws
   * `DomainError('conflict')` exactly as before; nothing about the conflict
   * path changes.
   *
   * `sharesLineOfWork` keeps this store ignorant of runs/chains/sessions: the
   * caller (the Runner's begin-transaction, where both the new owner and the
   * candidate predecessor are already resolved) decides what "same line of
   * work" means and passes the answer in as a predicate over the existing
   * owner's Run id.
   */
  acquireOrTransfer(
    key: string,
    ownerRunId: number,
    phase: string,
    sharesLineOfWork: (existingOwnerRunId: number) => boolean,
  ): WorkContextLeaseRow {
    const existing = this.getByKey(key);
    if (existing && sharesLineOfWork(existing.ownerRunId)) {
      const moved = this.transfer(existing.ownerRunId, ownerRunId);
      if (moved) return moved;
    }
    return this.acquire(key, ownerRunId, phase);
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
