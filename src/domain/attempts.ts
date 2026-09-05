import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import {
  attempts,
  steps,
  attemptEvents,
  attemptToolCalls,
  tasks,
  type AttemptRow,
  type AttemptState,
  type StepRow,
  type StepType,
  type AttemptEventRow,
} from '../db/schema.js';
import type { DeterministicContinuation } from './session-continuation.js';
import { DomainError } from './errors.js';
import type { ResolvedGuardrails } from './setting-override.js';
import { costOfUsages, type PriceTable } from './pricing.js';
import type { AttemptUsage } from './usage.js';
import { forEachYielding } from '../reliability/yield.js';

/** The Guardrail state an Attempt captures at start: the effective config and
 * price table, frozen so a later change can't retroactively trip it. */
export interface AttemptGuardrailSnapshot {
  guardrailConfig: ResolvedGuardrails;
  priceTable: PriceTable;
}

export interface StepInput {
  type: StepType;
  command?: string | null;
  logLocator?: string | null;
}

/** What `appendEvent` needs to persist one Attempt event — everything on
 * `AttemptEventRow` except the store-assigned `id`/`attemptId`/`seq`/`ts`. */
export interface AttemptEventInput {
  /** ACP transcript updates are never durable. */
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
  /** True iff this event is load-time `session/load` replay history. Absent on a current-turn event. */
  replay?: boolean | undefined;
}

function deserializeAttemptEvent(row: AttemptEventRow): PersistedAttemptEvent {
  return { ...row, payload: JSON.parse(row.payload) };
}

/**
 * The single execution ledger: one row per pass through a Ticket's
 * implement -> verify loop, carrying both its timeline identity
 * (number/state/Steps) and the live execution facts (branch, usage, cost,
 * diff OIDs, …).
 */
export class AttemptStore {
  constructor(private readonly db: AsyncDbHandle) {}

  /**
   * Allocate a fresh Attempt for `taskId`: its own next `number` and
   * `startedAt`. Fills in an existing `running` placeholder row (pre-created
   * by {@link ensureForRun} on the resume path) rather than inserting beside it.
   */
  async create(taskId: number, snapshot?: AttemptGuardrailSnapshot): Promise<AttemptRow> {
    return this.db.write(async (db) => {
      const values = {
        state: 'running' as const,
        startedAt: Date.now(),
        guardrailConfig: snapshot ? JSON.stringify(snapshot.guardrailConfig) : null,
        priceTable: snapshot ? JSON.stringify(snapshot.priceTable) : null,
      };
      const placeholder = await db.select().from(attempts).where(and(eq(attempts.taskId, taskId), eq(attempts.state, 'running'))).get();
      if (placeholder) {
        return db.update(attempts).set(values).where(eq(attempts.id, placeholder.id)).returning().get();
      }
      const number =
        ((
          await db
            .select({ n: sql<number>`coalesce(max(${attempts.number}), 0)` })
            .from(attempts)
            .where(eq(attempts.taskId, taskId))
            .get()
        )?.n ?? 0) + 1;
      return db
        .insert(attempts)
        .values({ taskId, number, ...values })
        .returning()
        .get();
    });
  }

  /** The single `running` Attempt for a Task (at most one is ever `running` per Task), or `undefined`. */
  async getRunningForTask(taskId: number): Promise<AttemptRow | undefined> {
    return this.db.read((db) =>
      db.select().from(attempts).where(and(eq(attempts.taskId, taskId), eq(attempts.state, 'running'))).get(),
    );
  }

  /** Get-or-create the Attempt for an explicit `(taskId, number)` — the reject/resume path. */
  async ensureForRun(taskId: number, number: number, startedAt: number): Promise<AttemptRow> {
    return this.db.write(async (db) => {
      const existing = await db.select().from(attempts).where(and(eq(attempts.taskId, taskId), eq(attempts.number, number))).get();
      return existing ?? db.insert(attempts).values({ taskId, number, startedAt }).returning().get();
    });
  }

  async assertExists(id: number): Promise<void> {
    await this.get(id);
  }

  listForTask(taskId: number): Promise<AttemptRow[]> {
    return this.db.read((db) => db.select().from(attempts).where(eq(attempts.taskId, taskId)).orderBy(asc(attempts.number)).all());
  }

  /** Attempts for a task list, ordered as {@link listForTask} orders each task's Attempts. */
  async listForTasks(taskIds: number[]): Promise<AttemptRow[]> {
    if (taskIds.length === 0) return [];
    return this.db.read((db) =>
      db.select().from(attempts).where(inArray(attempts.taskId, taskIds)).orderBy(asc(attempts.taskId), asc(attempts.number)).all(),
    );
  }

  listAll(): Promise<AttemptRow[]> {
    return this.db.read((db) => db.select().from(attempts).all());
  }

  listAllRunning(): Promise<AttemptRow[]> {
    return this.db.read((db) => db.select().from(attempts).where(eq(attempts.state, 'running')).all());
  }

  /** Every Attempt bound to one durable Session, oldest first. */
  listForSession(sessionRowId: number): Promise<AttemptRow[]> {
    return this.db.read((db) =>
      db.select().from(attempts).where(eq(attempts.sessionRowId, sessionRowId)).orderBy(asc(attempts.number)).all(),
    );
  }

  /** General patch write for bookkeeping that isn't a terminal transition. */
  update(id: number, patch: Partial<AttemptRow>): Promise<AttemptRow> {
    return this.db.write((db) =>
      db.update(attempts).set(patch).where(eq(attempts.id, id)).returning().get(),
    ) as Promise<AttemptRow>;
  }

  /** Write a final Usage and its Cost atomically. Once present, Cost never changes. */
  async updateWithFrozenCost(id: number, patch: Partial<AttemptRow>): Promise<AttemptRow> {
    return this.db.write(async (db) => {
      const current = await db.select().from(attempts).where(eq(attempts.id, id)).get();
      if (!current) throw new DomainError('not_found', `attempt ${id} not found`);
      const usage = patch.usage ?? current.usage;
      const cost = current.cost ?? patch.cost ?? frozenCost(usage, current.priceTable);
      return db.update(attempts).set({ ...patch, cost }).where(eq(attempts.id, id)).returning().get();
    });
  }

  /** Backfill Cost onto finished Attempts that have Usage but no stored Cost. */
  async backfillCosts(pricesForAttempt: (attempt: AttemptRow) => Promise<PriceTable>): Promise<void> {
    const candidates = await this.db.read((db) =>
      db
        .select()
        .from(attempts)
        .where(and(isNull(attempts.cost), isNotNull(attempts.usage), ne(attempts.state, 'running')))
        .all(),
    );
    await forEachYielding(candidates, async (attempt) => {
      const cost = frozenCost(attempt.usage, JSON.stringify(await pricesForAttempt(attempt)));
      if (cost === null) return;
      await this.db.write((db) => db.update(attempts).set({ cost }).where(and(eq(attempts.id, attempt.id), isNull(attempts.cost))).run());
    });
  }

  async delete(id: number): Promise<void> {
    await this.db.write((db) => db.delete(attempts).where(eq(attempts.id, id)).run());
  }

  /**
   * Crash recovery, run at boot: any Attempt still marked `running` was
   * orphaned by a restart. Fail it (`reason: 'process-death'`) and return it
   * so the caller can fail its task — never silently re-run on a possibly
   * dirty working directory.
   */
  async markInterrupted(): Promise<AttemptRow[]> {
    const orphans = await this.db.read((db) => db.select().from(attempts).where(eq(attempts.state, 'running')).all());
    for (const attempt of orphans) {
      await this.db.write((db) =>
        db
          .update(attempts)
          .set({ state: 'failed', reason: 'process-death', endedAt: Date.now() })
          .where(eq(attempts.id, attempt.id))
          .run(),
      );
    }
    return orphans;
  }

  /** Actively-executing Attempt count, for the Auto-Runner's Host-Ceiling concurrency cap. */
  async countRunning(): Promise<number> {
    const row = await this.db.read((db) =>
      db
        .select({ n: sql<number>`count(*)` })
        .from(attempts)
        .where(eq(attempts.state, 'running'))
        .get(),
    );
    return row?.n ?? 0;
  }

  /** The Attempts that consume Host-Ceiling capacity — the same predicate as {@link countRunning}. */
  async listRunning(): Promise<AttemptRow[]> {
    return this.db.read((db) => db.select().from(attempts).where(eq(attempts.state, 'running')).all());
  }

  /**
   * Running-Attempt count per owning Workspace, for the Auto-Runner's
   * per-Workspace concurrency cap. Workspaces with no running Attempt are
   * absent (read as 0).
   */
  async countRunningByWorkspace(): Promise<Map<number, number>> {
    const rows = await this.db.read((db) =>
      db
        .select({ workspaceId: tasks.workspaceId, n: sql<number>`count(*)` })
        .from(attempts)
        .innerJoin(tasks, eq(attempts.taskId, tasks.id))
        .where(eq(attempts.state, 'running'))
        .groupBy(tasks.workspaceId)
        .all(),
    );
    const counts = new Map<number, number>();
    for (const row of rows) if (row.workspaceId != null) counts.set(row.workspaceId, row.n);
    return counts;
  }

  /** Finished Attempts that never got a per-model usage split; candidates for the boot-time backfill. */
  listUsageBackfillCandidates(): Promise<AttemptRow[]> {
    return this.db.read(async (db) => {
      const finished = await db
        .select()
        .from(attempts)
        .where(and(ne(attempts.state, 'running'), isNotNull(attempts.sessionId)))
        .all();
      return finished.filter((attempt) => {
        if (!attempt.usage) return true;
        const models = (JSON.parse(attempt.usage) as { models?: Record<string, unknown> }).models;
        return !models || Object.keys(models).length === 0;
      });
    });
  }

  getForTaskNumber(taskId: number, number: number): Promise<AttemptRow | undefined> {
    return this.db.read((db) => db.select().from(attempts).where(and(eq(attempts.taskId, taskId), eq(attempts.number, number))).get());
  }

  async get(id: number): Promise<AttemptRow> {
    const row = await this.db.read((db) => db.select().from(attempts).where(eq(attempts.id, id)).get());
    if (!row) throw new DomainError('not_found', `attempt ${id} not found`);
    return row;
  }

  /** The Task's latest Attempt. */
  async currentForTask(taskId: number): Promise<AttemptRow> {
    const latest = await this.db.read((db) =>
      db.select().from(attempts).where(eq(attempts.taskId, taskId)).orderBy(asc(attempts.number)).all(),
    );
    const row = latest.at(-1);
    if (!row) throw new DomainError('not_found', `task ${taskId} has no attempts`);
    return row;
  }

  /** The batched form of {@link getForTaskNumber}'s `.id` projection, keyed by `taskId`. */
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

  /** The Step type currently `running` for one Task's Attempt, or `null` when none is (the gap between Steps). */
  async currentStepType(taskId: number, number: number): Promise<StepType | null> {
    const attempt = await this.getForTaskNumber(taskId, number);
    if (!attempt) return null;
    const rows = await this.listSteps(attempt.id);
    return [...rows].reverse().find((row) => row.state === 'running')?.type ?? null;
  }

  /** The batched form of {@link currentStepType}, keyed by `taskId`. */
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
   * The attempt number the `maxAttempts` budget counts from: the latest
   * escalated Attempt, or 0 when the ticket never escalated. Attempts keep
   * their history numbering; only the budget restarts.
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
   * Close an Attempt out: terminal `state` + `endedAt`, plus `reason`.
   * `feedback`/`reason` are left untouched when the caller doesn't pass them,
   * so an earlier write is never clobbered by a later close.
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

  /** Append an Attempt event, assigning the next monotonic `seq` (1-based). */
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

  /** An Attempt's persisted event log, in `seq` order. */
  async listEvents(attemptId: number): Promise<PersistedAttemptEvent[]> {
    await this.get(attemptId);
    const rows = await this.db.read((db) =>
      db.select().from(attemptEvents).where(eq(attemptEvents.attemptId, attemptId)).orderBy(asc(attemptEvents.seq)).all(),
    );
    return rows.map(deserializeAttemptEvent);
  }

  /** Per-Attempt tool-call snapshot, overwritten by the Runner's in-memory rollup. */
  async replaceToolCalls(attemptId: number, totals: ReadonlyMap<string, number>): Promise<void> {
    await this.db.write(async (db) => {
      await db.delete(attemptToolCalls).where(eq(attemptToolCalls.attemptId, attemptId)).run();
      const rows = [...totals].map(([toolName, count]) => ({ attemptId, toolName, count }));
      if (rows.length > 0) await db.insert(attemptToolCalls).values(rows).run();
    });
  }

  async listToolCalls(attemptId: number): Promise<Map<string, number>> {
    const rows = await this.db.read((db) =>
      db.select({ toolName: attemptToolCalls.toolName, count: attemptToolCalls.count }).from(attemptToolCalls).where(eq(attemptToolCalls.attemptId, attemptId)).all(),
    );
    return new Map(rows.map(({ toolName, count }) => [toolName, count]));
  }

  /** Total persisted tool calls for each supplied Attempt. */
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

function frozenCost(usage: string | null, rawPrices: string | null): string | null {
  if (!usage || !rawPrices) return null;
  return JSON.stringify(costOfUsages([JSON.parse(usage) as AttemptUsage], JSON.parse(rawPrices) as PriceTable));
}

/** The attempt/card API projection of one Attempt row. */
export function serializeAttempt(attempt: AttemptRow): Record<string, unknown> {
  const { liveUsage: _liveUsage, ...rest } = attempt;
  return {
    ...rest,
    usage: attempt.usage ? JSON.parse(attempt.usage) : null,
    cost: attempt.cost ? JSON.parse(attempt.cost) : null,
    guardrailConfig: attempt.guardrailConfig ? JSON.parse(attempt.guardrailConfig) : null,
    priceTable: attempt.priceTable ? JSON.parse(attempt.priceTable) : null,
  };
}
