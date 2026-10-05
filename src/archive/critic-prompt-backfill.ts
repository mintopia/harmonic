import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { TrackerRef } from '../tracker/adapter.js';
import type { AsyncDbHandle } from '../db/async.js';
import { attempts, settings, steps, verificationAttempts, type TaskRow } from '../db/schema.js';
import { reportFailure } from '../error-handling.js';
import { forEachYielding, yieldToEventLoop } from '../reliability/yield.js';
import type { TaskArchive } from './task-archive.js';

const BACKFILL_KEY = 'migration.critic-prompt-keys';
const PAGE_SIZE = 100;

export interface CriticPromptBackfillDeps {
  db: AsyncDbHandle;
  archive: Pick<TaskArchive, 'archivedCriticPromptKey'>;
  getTask: (taskId: number) => Promise<TaskRow>;
}

/** One-time boot backfill of `prompt_key` for critic runs recorded before it existed; errored passes retry next boot. */
export async function backfillCriticPromptKeys({ db, archive, getTask }: CriticPromptBackfillDeps): Promise<void> {
  const done = await db.read((d) => d.select({ value: settings.value }).from(settings).where(eq(settings.key, BACKFILL_KEY)).get());
  if (done) return;
  let after = 0;
  let failed = false;
  for (;;) {
    const page = await db.read((d) =>
      d
        .select({
          id: verificationAttempts.id,
          stepId: steps.id,
          attemptNumber: attempts.number,
          taskId: attempts.taskId,
          workspaceId: attempts.workspaceId,
          epicRef: attempts.epicRef,
        })
        .from(verificationAttempts)
        .innerJoin(attempts, eq(attempts.id, verificationAttempts.attemptId))
        .innerJoin(steps, and(eq(steps.attemptId, verificationAttempts.attemptId), eq(steps.logLocator, sql`'verification_attempt:' || ${verificationAttempts.id}`)))
        .where(and(gt(verificationAttempts.id, after), isNull(verificationAttempts.promptKey), eq(verificationAttempts.mechanism, 'critic')))
        .orderBy(asc(verificationAttempts.id))
        .limit(PAGE_SIZE)
        .all(),
    );
    const last = page.at(-1);
    if (!last) break;
    await forEachYielding(page, async (row) => {
      try {
        const owner: TaskRow | { workspaceId: number; epicRef: TrackerRef } | null =
          row.taskId !== null ? await getTask(row.taskId) : row.workspaceId !== null && row.epicRef !== null ? { workspaceId: row.workspaceId, epicRef: row.epicRef } : null;
        const key = owner ? await archive.archivedCriticPromptKey(owner, row.attemptNumber, String(row.stepId)) : null;
        if (key) await db.write((d) => d.update(verificationAttempts).set({ promptKey: key }).where(and(eq(verificationAttempts.id, row.id), isNull(verificationAttempts.promptKey))).run());
      } catch (err) {
        failed = true;
        reportFailure(err, { op: 'archive.backfillCriticPromptKey', level: 'warn', context: { verificationAttemptId: row.id } });
      }
    });
    after = last.id;
    await yieldToEventLoop();
  }
  if (failed) return;
  await db.write((d) => d.insert(settings).values({ key: BACKFILL_KEY, value: 'done' }).onConflictDoNothing().run());
}
