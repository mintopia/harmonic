import { asc, eq, sql } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import {
  verificationAttempts,
  type VerificationAttemptRow,
  type VerificationMechanism,
} from '../db/schema.js';
import type { Verdict } from '../verification/critic-schema.js';

/** What `append` needs to persist one Verification attempt — everything on
 * `VerificationAttemptRow` except the store-assigned `id`/`runId`/`seq`/`ts`. */
export interface VerificationAttemptInput {
  mechanism: VerificationMechanism;
  inputOid: string;
  verdict: Verdict;
  summary: string;
  output: string;
  /** The exact prompt sent to the critic (`buildCriticPrompt`); null for the
   * command verifier, which sends no prompt. */
  prompt?: string | null;
  /** Locator for the critic's native transcript + the harness that wrote it.
   * Both null for the command verifier and where no transcript was resolved. */
  transcriptPath?: string | null;
  harness?: string | null;
}

/**
 * The Verification attempt log store: every verifier invocation against an
 * Attempt's frozen candidate OID, as an immutable row with a per-Attempt
 * monotonic `seq`. Append and read only.
 */
export class VerificationAttemptStore {
  constructor(private readonly db: AsyncDbHandle) {}

  /** Append a Verification attempt to `attemptId`'s log, assigning the next monotonic `seq` (1-based). */
  append(attemptId: number, attempt: VerificationAttemptInput, now: number = Date.now()): Promise<VerificationAttemptRow> {
    return this.db.write(async (db) => {
      const seq =
        ((
          await db
            .select({ n: sql<number>`coalesce(max(${verificationAttempts.seq}), 0)` })
            .from(verificationAttempts)
            .where(eq(verificationAttempts.attemptId, attemptId))
            .get()
        )?.n ?? 0) + 1;
      return db
        .insert(verificationAttempts)
        .values({
          attemptId,
          seq,
          ts: now,
          mechanism: attempt.mechanism,
          inputOid: attempt.inputOid,
          verdict: attempt.verdict,
          summary: attempt.summary,
          output: attempt.output,
          prompt: attempt.prompt ?? null,
          transcriptPath: attempt.transcriptPath ?? null,
          harness: attempt.harness ?? null,
        })
        .returning()
        .get();
    });
  }

  /** Fill in a critic attempt's transcript locator after the fact: the harness
   * often has not flushed its `${sessionId}.jsonl` at the session-end boundary. */
  setTranscriptPath(id: number, transcriptPath: string): Promise<void> {
    return this.db.write(async (db) => {
      await db.update(verificationAttempts).set({ transcriptPath }).where(eq(verificationAttempts.id, id)).run();
    });
  }

  /** One attempt by id, or undefined. */
  get(id: number): Promise<VerificationAttemptRow | undefined> {
    return this.db.read((db) => db.select().from(verificationAttempts).where(eq(verificationAttempts.id, id)).get());
  }

  /** An Attempt's Verification attempt log in `seq` order. */
  list(attemptId: number): Promise<VerificationAttemptRow[]> {
    return this.db.read((db) =>
      db
        .select()
        .from(verificationAttempts)
        .where(eq(verificationAttempts.attemptId, attemptId))
        .orderBy(asc(verificationAttempts.seq))
        .all(),
    );
  }
}
