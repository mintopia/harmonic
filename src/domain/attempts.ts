import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import {
  attempts,
  steps,
  attemptEvents,
  attemptToolCalls,
  type AttemptRow,
  type AttemptState,
  type StepRow,
  type StepType,
  type AttemptEventRow,
} from '../db/schema.js';
import type { DeterministicContinuation } from './session-continuation.js';
import { DomainError } from './errors.js';

export interface StepInput {
  type: StepType;
  command?: string | null;
  logLocator?: string | null;
}

/** What `appendEvent` needs to persist one Attempt event — everything on
 * `AttemptEventRow` except the store-assigned `id`/`attemptId`/`seq`/`ts`. */
export interface AttemptEventInput {
  /** ACP transcript updates are deliberately never durable. See ADR-0031. */
  type: 'permission_request' | 'lifecycle';
  payload: unknown;
}

export interface PersistedAttemptEvent {
  id: number;
  attemptId: number;
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
  /** True iff this event is load-time `session/load` replay history, flagged by
   * the driver (issue #144). Every current-turn measurement — usage, stall,
   * activity — excludes it via `domain/replay-quarantine.ts`'s `isReplay`. Absent
   * on a current-turn event and on every event a pre-quarantine path recorded. */
  replay?: boolean | undefined;
}

function deserializeAttemptEvent(row: AttemptEventRow): PersistedAttemptEvent {
  return { ...row, payload: JSON.parse(row.payload) };
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

  async get(id: number): Promise<AttemptRow> {
    const row = await this.db.read((db) => db.select().from(attempts).where(eq(attempts.id, id)).get());
    if (!row) throw new DomainError('not_found', `attempt ${id} not found`);
    return row;
  }

  /**
   * The batched form of {@link getForTaskNumber}'s `.id` projection, keyed by
   * `taskId` — the bridge every attempt-keyed satellite table's batched
   * reader uses to resolve a Run's CURRENT attempt id (`runs.attempt`)
   * without one query per Run (ADR-0001 #388 S-F). Mirrors
   * {@link currentStepTypes}'s query shape.
   */
  async idsFor(taskAttempts: readonly { taskId: number; number: number }[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (taskAttempts.length === 0) return result;
    const numberByTask = new Map(taskAttempts.map((t) => [t.taskId, t.number]));
    const attemptRows = await this.db.read((db) =>
      db.select().from(attempts).where(inArray(attempts.taskId, taskAttempts.map((t) => t.taskId))).all(),
    );
    for (const row of attemptRows) if (numberByTask.get(row.taskId) === row.number) result.set(row.taskId, row.id);
    return result;
  }

  listSteps(attemptId: number): Promise<StepRow[]> {
    return this.db.read((db) => db.select().from(steps).where(eq(steps.attemptId, attemptId)).orderBy(asc(steps.position)).all());
  }

  /**
   * The Step type currently `running` for one Task's Attempt, or `null` when
   * none is (the gap between Steps, most notably the mechanical merge after
   * the last Step passes, or before the Attempt's first Step starts). This is
   * the single derivation every wall-clock/spend/tool-timeout Guardrail check
   * shares (`guardrail-budget.ts`'s `countsTowardExecutionBudget`), so a Run's
   * "what is it doing right now" reads the same way everywhere.
   */
  async currentStepType(taskId: number, number: number): Promise<StepType | null> {
    const attempt = await this.getForTaskNumber(taskId, number);
    if (!attempt) return null;
    const rows = await this.listSteps(attempt.id);
    return [...rows].reverse().find((row) => row.state === 'running')?.type ?? null;
  }

  /**
   * The batched form of {@link currentStepType}, keyed by `taskId` — one
   * query for the Attempts, one for their Steps, regardless of how many Tasks
   * are asked about (the Board's active-card badge, issue #100/#388).
   */
  async currentStepTypes(taskAttempts: readonly { taskId: number; number: number }[]): Promise<Map<number, StepType | null>> {
    const result = new Map<number, StepType | null>();
    if (taskAttempts.length === 0) return result;
    const numberByTask = new Map(taskAttempts.map((t) => [t.taskId, t.number]));
    const attemptRows = await this.db.read((db) =>
      db.select().from(attempts).where(inArray(attempts.taskId, taskAttempts.map((t) => t.taskId))).all(),
    );
    const wanted = attemptRows.filter((a) => numberByTask.get(a.taskId) === a.number);
    if (wanted.length === 0) return result;
    const stepRows = await this.db.read((db) =>
      db.select().from(steps).where(inArray(steps.attemptId, wanted.map((a) => a.id))).orderBy(asc(steps.position)).all(),
    );
    const stepsByAttempt = new Map<number, StepRow[]>();
    for (const row of stepRows) {
      const list = stepsByAttempt.get(row.attemptId) ?? [];
      list.push(row);
      stepsByAttempt.set(row.attemptId, list);
    }
    for (const attempt of wanted) {
      const running = [...(stepsByAttempt.get(attempt.id) ?? [])].reverse().find((row) => row.state === 'running');
      result.set(attempt.taskId, running?.type ?? null);
    }
    return result;
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

  createStep(attemptId: number, input: StepInput): Promise<StepRow> {
    return this.db.write(async (db) => {
      const position = ((await db.select({ n: sql<number>`coalesce(max(${steps.position}), 0)` }).from(steps).where(eq(steps.attemptId, attemptId)).get())?.n ?? 0) + 1;
      return db.insert(steps).values({ attemptId, position, type: input.type, command: input.command ?? null, logLocator: input.logLocator ?? null }).returning().get();
    });
  }

  updateStep(id: number, patch: Partial<Pick<StepRow, 'state' | 'verdict' | 'logLocator' | 'startedAt' | 'endedAt'>>): Promise<StepRow> {
    return this.db.write((db) => db.update(steps).set(patch).where(eq(steps.id, id)).returning().get()) as Promise<StepRow>;
  }

  /**
   * Close an Attempt out: terminal `state` + `endedAt`, plus the disposition-
   * kind audit hedge on `reason` (ADR-0001 #388 S-E — the whole coordination
   * spine collapsed onto this column; see `RunSettleCoordinator.settle`).
   * `feedback`/`reason` are omitted (not merely undefined) when the caller
   * doesn't pass them, so a caller that already set one earlier (e.g. a failed
   * verification's feedback) never gets clobbered by a later close that only
   * knows the other.
   */
  finish(attemptId: number, state: Exclude<AttemptState, 'running'>, now = Date.now(), feedback?: string, reason?: string | null): Promise<AttemptRow> {
    return this.db.write((db) => db.update(attempts).set({
      state,
      endedAt: now,
      ...(feedback === undefined ? {} : { feedback }),
      ...(reason === undefined ? {} : { reason }),
    }).where(eq(attempts.id, attemptId)).returning().get()) as Promise<AttemptRow>;
  }

  setContinuation(attemptId: number, continuation: DeterministicContinuation): Promise<AttemptRow> {
    return this.db.write((db) => db.update(attempts).set({ continuation: JSON.stringify(continuation) }).where(eq(attempts.id, attemptId)).returning().get()) as Promise<AttemptRow>;
  }

  /**
   * Append an Attempt event (lifecycle / permission_request — ADR-0007's "small
   * structured facts"; the `session_update` firehose was pruned outright at
   * migration 0042 and is never persisted), assigning the next monotonic `seq`
   * as `max(seq)+1` (1-based). Moved here from `RunStore.appendEvent` at
   * ADR-0001 #388 S-F (`attempt_events`, re-keyed off `attempt_id`).
   */
  async appendEvent(attemptId: number, event: AttemptEventInput): Promise<PersistedAttemptEvent> {
    const row = await this.db.write(async (db) => {
      const seq =
        ((
          await db
            .select({ n: sql<number>`coalesce(max(${attemptEvents.seq}), 0)` })
            .from(attemptEvents)
            .where(eq(attemptEvents.attemptId, attemptId))
            .get()
        )?.n ?? 0) + 1;
      return db
        .insert(attemptEvents)
        .values({ attemptId, seq, ts: Date.now(), type: event.type, payload: JSON.stringify(event.payload) })
        .returning()
        .get();
    });
    return deserializeAttemptEvent(row);
  }

  /** An Attempt's persisted event log, in `seq` order. Moved here from
   * `RunStore.listEvents` at ADR-0001 #388 S-F. */
  async listEvents(attemptId: number): Promise<PersistedAttemptEvent[]> {
    await this.get(attemptId); // 404 on unknown attempt
    const rows = await this.db.read((db) =>
      db.select().from(attemptEvents).where(eq(attemptEvents.attemptId, attemptId)).orderBy(asc(attemptEvents.seq)).all(),
    );
    return rows.map(deserializeAttemptEvent);
  }

  /** Per-Attempt tool-call snapshot, overwritten by the Runner's in-memory
   * rollup on the ADR-0010 coarse cadence and when a turn finishes (ADR-0031).
   * Moved here from `RunStore.replaceToolCalls` at ADR-0001 #388 S-F
   * (`attempt_tool_calls`, re-keyed off `attempt_id`). */
  async replaceToolCalls(attemptId: number, totals: ReadonlyMap<string, number>): Promise<void> {
    await this.db.write(async (db) => {
      await db.delete(attemptToolCalls).where(eq(attemptToolCalls.attemptId, attemptId)).run();
      const rows = [...totals].map(([toolName, count]) => ({ attemptId, toolName, count }));
      if (rows.length > 0) await db.insert(attemptToolCalls).values(rows).run();
    });
  }

  /** Moved here from `RunStore.listToolCalls` at ADR-0001 #388 S-F. */
  async listToolCalls(attemptId: number): Promise<Map<string, number>> {
    const rows = await this.db.read((db) =>
      db.select({ toolName: attemptToolCalls.toolName, count: attemptToolCalls.count }).from(attemptToolCalls).where(eq(attemptToolCalls.attemptId, attemptId)).all(),
    );
    return new Map(rows.map(({ toolName, count }) => [toolName, count]));
  }

  /** Total persisted tool calls for each supplied Attempt, for board list
   * serialization. Moved here from `RunStore.toolCallCounts` at ADR-0001
   * #388 S-F. */
  async toolCallCounts(attemptIds: number[]): Promise<Map<number, number>> {
    if (attemptIds.length === 0) return new Map();
    const rows = await this.db.read((db) =>
      db
        .select({ attemptId: attemptToolCalls.attemptId, count: sql<number>`sum(${attemptToolCalls.count})` })
        .from(attemptToolCalls)
        .where(inArray(attemptToolCalls.attemptId, attemptIds))
        .groupBy(attemptToolCalls.attemptId)
        .all(),
    );
    return new Map(rows.map(({ attemptId, count }) => [attemptId, count]));
  }
}
