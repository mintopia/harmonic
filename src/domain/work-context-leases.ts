import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import {
  workContextLeases,
  workContextLeaseDispositions,
  type WorkContextLeaseRow,
  type WorkContextLeaseDispositionRow,
} from '../db/schema.js';
import { DomainError } from './errors.js';
import { DEFAULT_LEASE_TTL, leaseExpiryFor, type LeaseTtl } from './lease-ttl.js';

/** The row an `acquire`/`acquireOrTransfer` INSERT persists — shared by the
 * standalone `acquire` (its own write unit) and the `acquireOrTransfer`
 * transaction so the guarded-INSERT values stay identical across both paths. */
function newLeaseValues(key: string, ownerRunId: number, phase: string, now: number) {
  return {
    key,
    phase,
    ownerRunId,
    heartbeat: now,
    // TTL-bounded from birth (issue #122): a spawn that dies before its first
    // heartbeat still has a non-null expiry, so the periodic sweep catches it
    // rather than holding the key forever on a null expiry.
    expiry: leaseExpiryFor(phase, now),
    state: 'held' as const,
    acquiredAt: now,
  };
}

/** Matches the SQLite message for a violated UNIQUE constraint, as a fallback
 * when the driver's `.code` isn't populated (e.g. wrapped errors). */
const UNIQUE_VIOLATION_MESSAGE = /UNIQUE constraint failed/;

/**
 * Detect a UNIQUE-constraint violation across both DB drivers (ADR-0029).
 * better-sqlite3 throws a `SqliteError` whose top-level `.code` is
 * `SQLITE_CONSTRAINT_UNIQUE`; drizzle-libsql wraps the driver error in a
 * `DrizzleQueryError` whose `.message` is `"Failed query: …"` (no
 * "UNIQUE constraint failed") and whose `.code` is undefined — the real code
 * (`.code === 'SQLITE_CONSTRAINT'`, `.extendedCode === 'SQLITE_CONSTRAINT_UNIQUE'`)
 * and message live on `.cause`. So walk the cause chain and check `.code`,
 * `.extendedCode`, and the message at every level.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    const { code, extendedCode } = e as { code?: string; extendedCode?: string };
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || extendedCode === 'SQLITE_CONSTRAINT_UNIQUE') {
      return true;
    }
    if (UNIQUE_VIOLATION_MESSAGE.test(e.message)) return true;
  }
  return false;
}

/** Matches the SQLite message for a violated FOREIGN KEY constraint, as a
 * fallback when a wrapped error's `.code` isn't populated. */
const FOREIGN_KEY_VIOLATION_MESSAGE = /FOREIGN KEY constraint failed/;

/**
 * Detect a FOREIGN-KEY-constraint violation across both DB drivers, mirroring
 * {@link isUniqueViolation}'s cause-chain walk (ADR-0029): drizzle-libsql wraps
 * the driver error so the real `.code`/`.extendedCode`
 * (`SQLITE_CONSTRAINT`/`SQLITE_CONSTRAINT_FOREIGNKEY`) and the message live on
 * `.cause`, not the top-level `DrizzleQueryError`.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    const { code, extendedCode } = e as { code?: string; extendedCode?: string };
    if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || extendedCode === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return true;
    }
    if (FOREIGN_KEY_VIOLATION_MESSAGE.test(e.message)) return true;
  }
  return false;
}

/**
 * The Work Context lease store (issue #118, ADR-0022, reliability-design
 * §0.5): persists exclusive occupancy claims over a `workContextKey`. The
 * `work_context_leases_key_unique` index is the compare-and-set acquire
 * primitive — `acquire` relies on the database to reject a second row for an
 * already-held (or suspect) key rather than racing a select-then-insert.
 *
 * Also owns the live TTL/heartbeat primitives (issue #122): `acquire` and
 * `heartbeat` set a phase-scoped expiry (`lease-ttl.ts`), and `sweepExpired`
 * flips a lapsed `held` lease to `suspect` — driven by the Runner's
 * coordinator heartbeat and the app's periodic sweep, respectively. The boot
 * reconciliation that flips a dead owner's lease to `suspect` or releases a
 * provably-clean one (#123) lives separately in `CrashRecoveryCoordinator`; it
 * drives the `listAll` / `markSuspect` / `release` primitives here and is the
 * backstop for a lease that never got a live TTL (e.g. a spawn that died
 * before its first heartbeat, or predates this machinery).
 */
export class WorkContextLeaseStore {
  constructor(private readonly db: AsyncDbHandle) {}

  /**
   * Acquire a lease on `key` for `ownerRunId`. Throws `DomainError('conflict')`
   * if the key is already held (or suspect) — the existing row is left
   * untouched.
   *
   * The single guarded INSERT is the compare-and-set (ADR-0029 §3): the
   * `work_context_leases_key_unique` index rejects the loser's row, so
   * exactly-one-winner is DB-enforced and survives the async single-writer queue
   * unchanged — the loser's rejection surfaces as a `DomainError('conflict')`.
   */
  async acquire(key: string, ownerRunId: number, phase: string): Promise<WorkContextLeaseRow> {
    const now = Date.now();
    try {
      return await this.db.write((db) =>
        db.insert(workContextLeases).values(newLeaseValues(key, ownerRunId, phase, now)).returning().get(),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DomainError('conflict', `Work Context lease already held for key "${key}"`);
      }
      throw err;
    }
  }

  /** Frees `key`; a no-op if nothing holds it. */
  async release(key: string): Promise<void> {
    await this.db.write((db) => db.delete(workContextLeases).where(eq(workContextLeases.key, key)).run());
  }

  /** Frees whatever `ownerRunId` holds, if anything; idempotent. */
  async releaseByOwner(ownerRunId: number): Promise<void> {
    await this.db.write((db) =>
      db.delete(workContextLeases).where(eq(workContextLeases.ownerRunId, ownerRunId)).run(),
    );
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
  async transfer(
    fromRunId: number,
    toRunId: number,
    now: number = Date.now(),
  ): Promise<WorkContextLeaseRow | undefined> {
    return this.db.write((db) =>
      db
        .update(workContextLeases)
        .set({ ownerRunId: toRunId, heartbeat: now })
        .where(eq(workContextLeases.ownerRunId, fromRunId))
        .returning()
        .get(),
    );
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
  async acquireOrTransfer(
    key: string,
    ownerRunId: number,
    phase: string,
    sharesLineOfWork: (existingOwnerRunId: number) => boolean,
  ): Promise<WorkContextLeaseRow> {
    const now = Date.now();
    // One write-queue transaction unit (ADR-0029 §3): the read-then-conditional-
    // write runs without any other writer interleaving between the holder lookup
    // and the transfer/acquire, exactly as the sync path relied on better-sqlite3's
    // synchrony for. The guarded INSERT on the fall-through still hits the
    // unique-key CAS, so an unrelated holder is rejected as a `conflict`.
    try {
      return await this.db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(workContextLeases)
          .where(eq(workContextLeases.key, key))
          .get();
        if (existing && sharesLineOfWork(existing.ownerRunId)) {
          const moved = await tx
            .update(workContextLeases)
            .set({ ownerRunId, heartbeat: now })
            .where(eq(workContextLeases.ownerRunId, existing.ownerRunId))
            .returning()
            .get();
          if (moved) return moved;
        }
        return await tx
          .insert(workContextLeases)
          .values(newLeaseValues(key, ownerRunId, phase, now))
          .returning()
          .get();
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DomainError('conflict', `Work Context lease already held for key "${key}"`);
      }
      throw err;
    }
  }

  /**
   * Bumps the liveness heartbeat on `key`'s lease, if one exists (issue
   * #122). Always sets `heartbeat: now`. When `phase` is provided, also
   * updates `phase` and re-derives `expiry` from the phase-scoped TTL
   * (`leaseExpiryFor`) — the coordinator-driven heartbeat passes the Run's
   * current phase on every beat, so the budget tracks phase transitions
   * (e.g. execution → review) without a separate call. Omitting `phase`
   * keeps the pre-#122 behaviour: bump the timestamp only, expiry untouched
   * — callers that don't yet know (or care about) TTL scoping are unaffected.
   */
  async heartbeat(
    key: string,
    now: number = Date.now(),
    phase?: string,
    ttl: LeaseTtl = DEFAULT_LEASE_TTL,
  ): Promise<void> {
    const patch: Partial<typeof workContextLeases.$inferInsert> = { heartbeat: now };
    if (phase !== undefined) {
      patch.phase = phase;
      patch.expiry = leaseExpiryFor(phase, now, ttl);
    }
    await this.db.write((db) =>
      db.update(workContextLeases).set(patch).where(eq(workContextLeases.key, key)).run(),
    );
  }

  getByKey(key: string): Promise<WorkContextLeaseRow | undefined> {
    return this.db.read((db) => db.select().from(workContextLeases).where(eq(workContextLeases.key, key)).get());
  }

  getByOwner(ownerRunId: number): Promise<WorkContextLeaseRow | undefined> {
    return this.db.read((db) =>
      db.select().from(workContextLeases).where(eq(workContextLeases.ownerRunId, ownerRunId)).get(),
    );
  }

  /** Every lease row currently persisted — the boot reconciliation sweep
   * (#123) reads this to reconcile leases a crash left behind. */
  listAll(): Promise<WorkContextLeaseRow[]> {
    return this.db.read((db) => db.select().from(workContextLeases).all());
  }

  /**
   * Flip `key`'s lease to `suspect` (#123): a dead owner's claim that could not
   * be proven safe to free (dirty context / detached HEAD / retained worktree).
   * A suspect lease still holds the key — the unique index is on `key` alone, so
   * it keeps blocking new acquires — and stays owned and diagnosable until
   * operator disposition; it is never auto-released. A no-op if `key` holds
   * nothing.
   */
  async markSuspect(key: string): Promise<void> {
    await this.db.write((db) =>
      db.update(workContextLeases).set({ state: 'suspect' }).where(eq(workContextLeases.key, key)).run(),
    );
  }

  /**
   * Flip every `held` lease whose non-null `expiry` has lapsed (`<= now`) to
   * `suspect` (issue #122 acceptance: a lapsed heartbeat transitions the
   * lease held → suspect). Driven both by the Runner's coordinator heartbeat
   * (indirectly — a genuinely alive Run keeps bumping `expiry` ahead of `now`)
   * and by the app's periodic live sweep.
   *
   * Never releases — a suspect lease still holds the key (the unique index is
   * on `key` alone), so it keeps blocking a fresh `acquire` exactly like
   * `markSuspect`'s result does; only an explicit `release` (or later
   * operator disposition) frees it. A `null`-expiry row (never heartbeated)
   * and an already-`suspect` row are both left alone — this is a live sweep,
   * not the boot reconciliation backstop (#123) that covers the null-expiry
   * gap. Returns the swept rows in their post-flip `state: 'suspect'` shape.
   */
  sweepExpired(now: number = Date.now()): Promise<WorkContextLeaseRow[]> {
    return this.db.write((db) =>
      db
        .update(workContextLeases)
        .set({ state: 'suspect' })
        .where(
          and(
            eq(workContextLeases.state, 'held'),
            isNotNull(workContextLeases.expiry),
            lte(workContextLeases.expiry, now),
          ),
        )
        .returning()
        .all(),
    );
  }

  /** Every lease currently `suspect` (issue #122): feeds boot reconciliation
   * (#123) and operator diagnostics — the queryable surface for AC4. */
  listSuspect(): Promise<WorkContextLeaseRow[]> {
    return this.db.read((db) =>
      db.select().from(workContextLeases).where(eq(workContextLeases.state, 'suspect')).all(),
    );
  }

  /**
   * Operator supersede (issue #125, ADR-0022): re-point `key`'s lease to
   * `targetRunId`, re-admitting it as `held` with a fresh phase-scoped expiry
   * — the manual escape for a `suspect` lease that boot reconciliation (#123)
   * or the live sweep (#122) could only flag, never resolve, e.g. because the
   * dead owner's context couldn't be proven clean. Throws
   * `DomainError('not_found')` if `key` holds nothing — there is no lease to
   * supersede. The row mutation and the audit append happen in one
   * transaction, so a crash between them can never leave a superseded lease
   * without its disposition record (or vice versa).
   */
  supersede(key: string, targetRunId: number, now: number = Date.now()): Promise<WorkContextLeaseRow> {
    // The existence check reads *inside* the transaction so it and the
    // row-mutation + audit append are one atomic write-queue unit: a `not_found`
    // throw rolls the (empty) transaction back and writes nothing.
    return this.db.transaction(async (tx) => {
      const existing = await tx.select().from(workContextLeases).where(eq(workContextLeases.key, key)).get();
      if (!existing) throw new DomainError('not_found', `no Work Context lease held for key "${key}"`);
      const updated = (await tx
        .update(workContextLeases)
        .set({
          ownerRunId: targetRunId,
          state: 'held',
          heartbeat: now,
          expiry: leaseExpiryFor(existing.phase, now),
        })
        .where(eq(workContextLeases.key, key))
        .returning()
        .get())!;
      await tx
        .insert(workContextLeaseDispositions)
        .values({
          key,
          action: 'supersede',
          targetRunId,
          previousOwnerRunId: existing.ownerRunId,
          previousState: existing.state,
          at: now,
        })
        .run();
      return updated;
    });
  }

  /**
   * Operator unlock (issue #125, ADR-0022): force-release `key`'s lease
   * outright, freeing it for a fresh acquire — the manual escape when no Run
   * should inherit the stuck context (contrast `supersede`, which hands it to
   * a named Run). Throws `DomainError('not_found')` if `key` holds nothing.
   * The delete and the audit append happen in one transaction, matching
   * `supersede`'s atomicity guarantee.
   */
  async forceRelease(key: string, now: number = Date.now()): Promise<void> {
    // Existence check inside the transaction, matching `supersede`: a `not_found`
    // throw rolls back before the delete + audit append and writes nothing.
    await this.db.transaction(async (tx) => {
      const existing = await tx.select().from(workContextLeases).where(eq(workContextLeases.key, key)).get();
      if (!existing) throw new DomainError('not_found', `no Work Context lease held for key "${key}"`);
      await tx.delete(workContextLeases).where(eq(workContextLeases.key, key)).run();
      await tx
        .insert(workContextLeaseDispositions)
        .values({
          key,
          action: 'unlock',
          targetRunId: null,
          previousOwnerRunId: existing.ownerRunId,
          previousState: existing.state,
          at: now,
        })
        .run();
    });
  }

  /** The full operator-disposition audit log (issue #125), oldest first —
   * every `supersede`/`unlock` ever issued, surviving whatever later happened
   * to the lease row itself. */
  listDispositions(): Promise<WorkContextLeaseDispositionRow[]> {
    return this.db.read((db) =>
      db.select().from(workContextLeaseDispositions).orderBy(asc(workContextLeaseDispositions.id)).all(),
    );
  }
}
