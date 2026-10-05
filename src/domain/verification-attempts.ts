import { and, asc, eq, gt, isNull, like, sql } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import {
  settings,
  verificationAttempts,
  type VerificationAttemptRow,
  type VerificationMechanism,
} from '../db/schema.js';
import { forEachYielding, yieldToEventLoop } from '../reliability/yield.js';
import type { Verdict } from '../verification/critic-schema.js';

/** What `append` needs to persist one Verification attempt — everything on
 * `VerificationAttemptRow` except the store-assigned `id`/`runId`/`seq`/`ts`. */
export interface VerificationAttemptInput {
  mechanism: VerificationMechanism;
  inputOid: string;
  verdict: Verdict;
  summary: string;
  output: string;
  /** Archive-relative key of the complete command output; see `verificationAttempts.fullOutputKey`. */
  fullOutputKey?: string | null;
  /** Archive locator of the critic's Resolved Prompt; see `verificationAttempts.promptKey`. */
  promptKey?: string | null;
  /** Locator for the critic's native transcript + the harness that wrote it.
   * Both null for the command verifier and where no transcript was resolved. */
  transcriptPath?: string | null;
  harness?: string | null;
  /** The critic turn's `AttemptUsage` as JSON; usually filled in after the fact
   * via {@link VerificationAttemptStore.setUsage} once the session log settles. */
  usage?: string | null;
}

const LEGACY_FULL_OUTPUT_MARKER =
  /(…\[truncated \d+ chars); full output: [^\n]*?[\\/](verification[\\/](?:pre-merge|post-merge)[\\/][^\\/\n]+[\\/]output\.log)(\]…)/;
const FULL_OUTPUT_BACKFILL_KEY = 'migration.verification-full-output-keys';
const BACKFILL_PAGE_SIZE = 100;

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
          fullOutputKey: attempt.fullOutputKey ?? null,
          promptKey: attempt.promptKey ?? null,
          transcriptPath: attempt.transcriptPath ?? null,
          harness: attempt.harness ?? null,
          usage: attempt.usage ?? null,
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

  /** Fill in a critic attempt's usage after the fact, from the settled critic
   * session log — the harness rarely has its tokens ready at session end. */
  setUsage(id: number, usage: string): Promise<void> {
    return this.db.write(async (db) => {
      await db.update(verificationAttempts).set({ usage }).where(eq(verificationAttempts.id, id)).run();
    });
  }

  /** One-time boot backfill (marked done in `settings`): rows that embedded the full-output path in `output` get it moved into `fullOutputKey`. Paged by id so output is only held a page at a time. */
  async backfillFullOutputKeys(): Promise<void> {
    const done = await this.db.read((db) => db.select({ value: settings.value }).from(settings).where(eq(settings.key, FULL_OUTPUT_BACKFILL_KEY)).get());
    if (done) return;
    let after = 0;
    for (;;) {
      const page = await this.db.read((db) =>
        db
          .select({ id: verificationAttempts.id, output: verificationAttempts.output })
          .from(verificationAttempts)
          .where(and(gt(verificationAttempts.id, after), isNull(verificationAttempts.fullOutputKey), eq(verificationAttempts.mechanism, 'command'), like(verificationAttempts.output, '%full output: %')))
          .orderBy(asc(verificationAttempts.id))
          .limit(BACKFILL_PAGE_SIZE)
          .all(),
      );
      const last = page.at(-1);
      if (!last) break;
      await forEachYielding(page, async (row) => {
        const match = LEGACY_FULL_OUTPUT_MARKER.exec(row.output);
        if (!match) return;
        const fullOutputKey = match[2]!.replaceAll('\\', '/');
        const output = row.output.replace(LEGACY_FULL_OUTPUT_MARKER, '$1$3');
        await this.db.write((db) => db.update(verificationAttempts).set({ output, fullOutputKey }).where(eq(verificationAttempts.id, row.id)).run());
      });
      after = last.id;
      await yieldToEventLoop();
    }
    await this.db.write((db) => db.insert(settings).values({ key: FULL_OUTPUT_BACKFILL_KEY, value: 'done' }).onConflictDoNothing().run());
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
