import { asc, eq, sql } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import {
  verificationAttempts,
  type VerificationAttemptRow,
  type VerificationMechanism,
} from '../db/schema.js';
import type { RunPhase } from './run-phases.js';
import type { Verdict } from '../verification/critic-schema.js';

/** What `append` needs to persist one Verification attempt — everything on
 * `VerificationAttemptRow` except the store-assigned `id`/`runId`/`seq`/`ts`. */
export interface VerificationAttemptInput {
  mechanism: VerificationMechanism;
  inputOid: string;
  verdict: Verdict;
  summary: string;
  output: string;
  /** Defaults to `'verifying'` — the only phase a Verification attempt runs
   * in today (mirrors the schema column's default). */
  phase?: RunPhase;
  /** Locator for the critic's native transcript + the harness that wrote it
   * (ADR-0040). Both null for the command verifier and where no transcript was
   * resolved; the pair is what the attempt-log endpoint parses on demand. */
  transcriptPath?: string | null;
  harness?: string | null;
}

/**
 * The Verification attempt log store (issue #136, ADR-0021, reliability-design
 * Unit B): persists every verifier invocation — today only the agent critic
 * (`verification/critic.ts`'s `runCritic`) — against a Run's frozen candidate
 * OID, as an immutable row with a per-Run monotonic `seq`. Mirrors
 * `RunFactStore` (`domain/run-facts.ts`) exactly, down to the `seq`-assignment
 * recipe and its rationale: the store class itself is pure persistence
 * substrate — it decides nothing and combines no verdicts. But its appended
 * attempts now drive the live verify path: the runner reads them back, folds
 * the verdicts through `combineVerdicts`, and settles the Run on the result
 * (`execution/runner.ts`, #135/#164). Attempts are only ever appended and
 * read; there is no update or delete path, by design.
 */
export class VerificationAttemptStore {
  constructor(private readonly db: AsyncDbHandle) {}

  /**
   * Append a Verification attempt to `runId`'s log, assigning the next
   * monotonic `seq` as `max(seq)+1` (1-based) — same recipe, and the same
   * cross-process integrity backstop (the `(run_id, seq)` unique index
   * rejects a racing duplicate `seq` with a raw UNIQUE violation rather than
   * corrupting the log's total order), as `RunFactStore.append`. The read of
   * `max(seq)` and the insert run as a single `this.db.write()` unit (ADR-0029
   * §3): the async single-writer queue now stands in for better-sqlite3's
   * synchrony, so no concurrent append can interleave between them and steal
   * the `seq`.
   */
  append(runId: number, attempt: VerificationAttemptInput, now: number = Date.now()): Promise<VerificationAttemptRow> {
    return this.db.write(async (db) => {
      const seq =
        ((
          await db
            .select({ n: sql<number>`coalesce(max(${verificationAttempts.seq}), 0)` })
            .from(verificationAttempts)
            .where(eq(verificationAttempts.runId, runId))
            .get()
        )?.n ?? 0) + 1;
      return db
        .insert(verificationAttempts)
        .values({
          runId,
          seq,
          ts: now,
          mechanism: attempt.mechanism,
          inputOid: attempt.inputOid,
          verdict: attempt.verdict,
          summary: attempt.summary,
          output: attempt.output,
          phase: attempt.phase ?? 'verifying',
          transcriptPath: attempt.transcriptPath ?? null,
          harness: attempt.harness ?? null,
        })
        .returning()
        .get();
    });
  }

  /** Fill in a critic attempt's transcript locator after the fact (ADR-0040).
   * The harness often has not flushed its `${sessionId}.jsonl` at the
   * session-end boundary, so `append` stores a null path; the runner's
   * deferred, non-blocking poll resolves it later and writes it here. */
  setTranscriptPath(id: number, transcriptPath: string): Promise<void> {
    return this.db.write(async (db) => {
      await db.update(verificationAttempts).set({ transcriptPath }).where(eq(verificationAttempts.id, id)).run();
    });
  }

  /** One attempt by id, or undefined — backs the attempt-log endpoint, which
   * reads back the row's `transcriptPath`/`harness` to parse its critic log. */
  get(id: number): Promise<VerificationAttemptRow | undefined> {
    return this.db.read((db) => db.select().from(verificationAttempts).where(eq(verificationAttempts.id, id)).get());
  }

  /** A Run's Verification attempt log in `seq` order. */
  list(runId: number): Promise<VerificationAttemptRow[]> {
    return this.db.read((db) =>
      db
        .select()
        .from(verificationAttempts)
        .where(eq(verificationAttempts.runId, runId))
        .orderBy(asc(verificationAttempts.seq))
        .all(),
    );
  }
}
