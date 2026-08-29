import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { attempts, steps, runFacts, type AttemptRow, type AttemptState, type StepRow, type StepType, type RunFactType } from '../db/schema.js';
import type { DeterministicContinuation } from './session-continuation.js';

export interface StepInput {
  type: StepType;
  command?: string | null;
  logLocator?: string | null;
}

/** Durable ticket timeline. It is intentionally independent from legacy Runs. */
export class AttemptStore {
  constructor(private readonly db: AsyncDbHandle) {}

  async ensureForRun(taskId: number, number: number, startedAt: number): Promise<AttemptRow> {
    return this.db.write(async (db) => {
      const existing = await db.select().from(attempts).where(and(eq(attempts.taskId, taskId), eq(attempts.number, number))).get();
      return existing ?? db.insert(attempts).values({ taskId, number, startedAt }).returning().get();
    });
  }

  listForTask(taskId: number): Promise<AttemptRow[]> {
    return this.db.read((db) => db.select().from(attempts).where(eq(attempts.taskId, taskId)).orderBy(asc(attempts.number)).all());
  }

  getForTaskNumber(taskId: number, number: number): Promise<AttemptRow | undefined> {
    return this.db.read((db) => db.select().from(attempts).where(and(eq(attempts.taskId, taskId), eq(attempts.number, number))).get());
  }

  listSteps(attemptId: number): Promise<StepRow[]> {
    return this.db.read((db) => db.select().from(steps).where(eq(steps.attemptId, attemptId)).orderBy(asc(steps.position)).all());
  }

  /** The immutable branch tip that the Attempt's verification proved. */
  verifiedSha(attemptId: number): Promise<string | null> {
    return this.latestFactField(attemptId, 'verified-head', 'sha');
  }

  /** Why the Attempt handed the ticket to a human, from its settle fact. */
  escalationReason(attemptId: number): Promise<string | null> {
    return this.latestFactField(attemptId, 'escalate', 'reason');
  }

  /**
   * The attempt number the `maxAttempts` budget counts from (ADR-0041 "Reject
   * with guidance: counter resets"): the latest escalated Attempt, or 0 when the
   * ticket never escalated. Attempts keep their history numbering; only the
   * budget restarts, so `attempt - budgetBase` is the attempts spent since the
   * operator last resumed the loop.
   */
  async budgetBase(taskId: number): Promise<number> {
    const row = await this.db.read((db) =>
      db
        .select({ n: sql<number>`coalesce(max(${attempts.number}), 0)` })
        .from(attempts)
        .where(and(eq(attempts.taskId, taskId), eq(attempts.state, 'escalated')))
        .get(),
    );
    return row?.n ?? 0;
  }

  /** Record the operator's guidance on the Attempt it answers (the escalated one). */
  setFeedback(attemptId: number, feedback: string): Promise<AttemptRow> {
    return this.db.write((db) => db.update(attempts).set({ feedback }).where(eq(attempts.id, attemptId)).returning().get()) as Promise<AttemptRow>;
  }

  private async latestFactField(attemptId: number, type: RunFactType, field: string): Promise<string | null> {
    const fact = await this.db.read((db) =>
      db.select().from(runFacts)
        .where(and(eq(runFacts.attemptId, attemptId), eq(runFacts.type, type)))
        .orderBy(desc(runFacts.id))
        .get(),
    );
    if (!fact) return null;
    try {
      const payload: unknown = JSON.parse(fact.payload);
      const value: unknown = typeof payload === 'object' && payload !== null ? Reflect.get(payload, field) : undefined;
      return typeof value === 'string' ? value : null;
    } catch {
      // A malformed historical fact is absent proof, never a fabricated value.
      return null;
    }
  }

  createStep(attemptId: number, input: StepInput): Promise<StepRow> {
    return this.db.write(async (db) => {
      const position = ((await db.select({ n: sql<number>`coalesce(max(${steps.position}), 0)` }).from(steps).where(eq(steps.attemptId, attemptId)).get())?.n ?? 0) + 1;
      return db.insert(steps).values({ attemptId, position, type: input.type, command: input.command ?? null, logLocator: input.logLocator ?? null }).returning().get();
    });
  }

  updateStep(id: number, patch: Partial<Pick<StepRow, 'state' | 'verdict' | 'logLocator' | 'startedAt' | 'endedAt'>>): Promise<StepRow> {
    return this.db.write((db) => db.update(steps).set(patch).where(eq(steps.id, id)).returning().get()) as Promise<StepRow>;
  }

  finish(attemptId: number, state: Exclude<AttemptState, 'running'>, now = Date.now(), feedback?: string): Promise<AttemptRow> {
    return this.db.write((db) => db.update(attempts).set({ state, endedAt: now, ...(feedback === undefined ? {} : { feedback }) }).where(eq(attempts.id, attemptId)).returning().get()) as Promise<AttemptRow>;
  }

  setContinuation(attemptId: number, continuation: DeterministicContinuation): Promise<AttemptRow> {
    return this.db.write((db) => db.update(attempts).set({ continuation: JSON.stringify(continuation) }).where(eq(attempts.id, attemptId)).returning().get()) as Promise<AttemptRow>;
  }
}
