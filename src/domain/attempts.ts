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
import { costOfUsages, type PriceTable } from '../execution/pricing.js';
import type { RunUsage } from '../execution/usage.js';
import { forEachYielding } from '../reliability/yield.js';

/** The Guardrail state an Attempt captures at start (issue #126): the effective
 * config and price table, frozen so a later change can't retroactively trip it.
 * Folded from `domain/runs.ts`'s `RunGuardrailSnapshot` (ADR-0001 #388 S-G). */
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

/** Durable ticket timeline.
 *
 * The single execution ledger (ADR-0001 #388 S-G, ADR-0007): one row per pass
 * through a Ticket's implement -> verify loop, carrying both its timeline
 * identity (number/state/Steps) and the live execution facts (branch, usage,
 * cost, diff OIDs, …) formerly split across a parallel `runs` row. Subsumes
 * every still-used responsibility of the deleted `RunStore`.
 */
export class AttemptStore {
  constructor(private readonly db: AsyncDbHandle) {}

  /**
   * Allocate a fresh Attempt for `taskId`: its own next `number` and
   * `startedAt`, never derived from a separate Run row (ADR-0001 #388 S-G —
   * the Runner's drive loop threads this ONE object from here on). Read-then-
   * write as one write-queue unit so the number CAS can't race a concurrent
   * create for the same Task (ADR-0029 §3). Moved from `RunStore.create`.
   *
   * Upserts onto an existing `running` row rather than blindly inserting:
   * `resumeWithGuidance` pre-creates the next Attempt's row (via
   * {@link ensureForRun}, defaulting `running`) to hang feedback/continuation
   * off it before a requeued Task is actually picked back up. There is no
   * longer a separate Run-creation step with its own independent numbering
   * that happens to land on the same number by coincidence (the old
   * `RunStore.create` + `AttemptStore.ensureForRun` pair) — a number-based
   * lookup here would always miss (the placeholder's own number already
   * counts toward "next"), so this looks for the Task's live placeholder
   * directly and fills it in, only allocating a fresh number when none exists.
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

  /**
   * The single `running` Attempt for a Task, or `undefined` when none is
   * (the Task never started, or its last Attempt already settled). The Runner's
   * self-heal loop finishes one Attempt before creating the next (ADR-0001 #388
   * S-G), so at most one row is ever `running` per Task — this is the DB-truth
   * replacement for threading a mutable "current attempt number" cursor through
   * every guardrail/verification closure: querying live state is crash-safe by
   * construction, where a threaded cursor would need its own persistence.
   */
  async getRunningForTask(taskId: number): Promise<AttemptRow | undefined> {
    return this.db.read((db) =>
      db.select().from(attempts).where(and(eq(attempts.taskId, taskId), eq(attempts.state, 'running'))).get(),
    );
  }

  /** Get-or-create the Attempt for an explicit `(taskId, number)` — the reject/
   * resume path, which computes the next attempt number itself from the
   * escalated Attempt's history (`resumeWithGuidance`). */
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

  /** Attempts for a task list, ordered as {@link listForTask} orders each task's Attempts. Moved from `RunStore.listForTasks`. */
  async listForTasks(taskIds: number[]): Promise<AttemptRow[]> {
    if (taskIds.length === 0) return [];
    return this.db.read((db) =>
      db.select().from(attempts).where(inArray(attempts.taskId, taskIds)).orderBy(asc(attempts.taskId), asc(attempts.number)).all(),
    );
  }

  /** Every Attempt row, unfiltered. Branch retirement scans it to find
   * Attempts to retire. Moved from `RunStore.listAll`. */
  listAll(): Promise<AttemptRow[]> {
    return this.db.read((db) => db.select().from(attempts).all());
  }

  /** Every running Attempt. Its builder and disposable verification worktrees
   * are live until the Attempt settles, even when no durable Session owns
   * them. Moved from `RunStore.listAllRunning`. */
  listAllRunning(): Promise<AttemptRow[]> {
    return this.db.read((db) => db.select().from(attempts).where(eq(attempts.state, 'running')).all());
  }

  /** Every Attempt bound to one durable Session (issue #148), oldest first —
   * the Attempts that share the Session's builder worktree across a retry /
   * reject continuation. Session retirement uses this to check no live
   * Attempt of the Session is still active (`running`). Moved from
   * `RunStore.listForSession`. */
  listForSession(sessionRowId: number): Promise<AttemptRow[]> {
    return this.db.read((db) =>
      db.select().from(attempts).where(eq(attempts.sessionRowId, sessionRowId)).orderBy(asc(attempts.number)).all(),
    );
  }

  /** General patch write (branch/session/diff/usage bookkeeping that isn't a
   * terminal transition). Moved from `RunStore.update`. */
  update(id: number, patch: Partial<AttemptRow>): Promise<AttemptRow> {
    return this.db.write((db) =>
      db.update(attempts).set(patch).where(eq(attempts.id, id)).returning().get(),
    ) as Promise<AttemptRow>;
  }

  /** Write a final Usage and its Cost atomically. Once present, Cost never
   * changes. Moved from `RunStore.updateWithFrozenCost`. */
  async updateWithFrozenCost(id: number, patch: Partial<AttemptRow>): Promise<AttemptRow> {
    return this.db.write(async (db) => {
      const current = await db.select().from(attempts).where(eq(attempts.id, id)).get();
      if (!current) throw new DomainError('not_found', `attempt ${id} not found`);
      const usage = patch.usage ?? current.usage;
      const cost = current.cost ?? patch.cost ?? frozenCost(usage, current.priceTable);
      return db.update(attempts).set({ ...patch, cost }).where(eq(attempts.id, id)).returning().get();
    });
  }

  /** One deliberate migration backfill for Attempts that predate stored Cost.
   * Moved from `RunStore.backfillCosts`. */
  async backfillCosts(fallbackPrices: PriceTable): Promise<void> {
    const candidates = await this.db.read((db) =>
      db
        .select()
        .from(attempts)
        .where(and(isNull(attempts.cost), isNotNull(attempts.usage), ne(attempts.state, 'running')))
        .all(),
    );
    await forEachYielding(candidates, async (attempt) => {
      // Pre-ADR Attempts were priced from the live table on every read. The
      // one deliberate backfill preserves that last visible value, rather
      // than applying their old guardrail snapshot.
      const cost = frozenCost(attempt.usage, JSON.stringify(fallbackPrices));
      if (cost === null) return;
      await this.db.write((db) => db.update(attempts).set({ cost }).where(and(eq(attempts.id, attempt.id), isNull(attempts.cost))).run());
    });
  }

  /** Remove an Attempt row (used to simulate/handle a row removed out from
   * under the Runner mid-flight). Moved from `RunStore.delete`. */
  async delete(id: number): Promise<void> {
    await this.db.write((db) => db.delete(attempts).where(eq(attempts.id, id)).run());
  }

  /**
   * Crash recovery, run at boot: any Attempt still marked `running` was
   * orphaned by a restart. Fail it (`reason: 'process-death'`, the same
   * disposition vocabulary `attempts.reason` already carries — ADR-0001 #388
   * S-E/S-G) and return it so the caller can fail its task (and notify) —
   * never silently re-run on a possibly dirty working directory. Moved from
   * `RunStore.markInterrupted`.
   *
   * Sole caller: `CrashRecoveryCoordinator.reconcile` (domain/crash-recovery.ts),
   * always as its second pass — a worktree-mode Attempt whose merge already
   * landed (per `git merge-base --is-ancestor`) is settled directly by that
   * first pass and so is no longer `running` by the time this runs (ADR-0001:
   * crash recovery relies on git's own idempotence, not a journal).
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

  /** Actively-executing Attempt count, for the Auto-Runner's Machine-Ceiling
   * concurrency cap (ADR-0012). Moved from `RunStore.countRunning`. */
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

  /** The Attempts that consume Machine-Ceiling capacity — the same predicate
   * as {@link countRunning}, so Activity cannot silently diverge from
   * scheduling. Moved from `RunStore.listRunning`. */
  async listRunning(): Promise<AttemptRow[]> {
    return this.db.read((db) => db.select().from(attempts).where(eq(attempts.state, 'running')).all());
  }

  /**
   * Running-Attempt count per owning Workspace, for the Auto-Runner's
   * per-Workspace concurrency cap (ADR-0012, issue #60). Attempts carry no
   * Workspace column, so the count joins through the Task; the same source as
   * {@link countRunning}, so the per-Workspace tallies and the Machine-Ceiling
   * total can never disagree. Workspaces with no running Attempt are absent
   * (read as 0). Moved from `RunStore.countRunningByWorkspace`.
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

  /**
   * Finished Attempts that never got a per-model usage split — their end
   * collection raced the harness's session-log flush. Candidates for the
   * boot-time backfill. Moved from `RunStore.listUsageBackfillCandidates`.
   */
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

  /**
   * Resolve `id` to its Task's LATEST Attempt — the "follow forward" read a
   * `runId` handle (issued once, at dispatch) needs now that self-heal
   * advances to a NEW Attempt row each turn (ADR-0001 #388 S-G: one row per
   * turn, not a stable Run row live-updated in place). Every `/api/runs/:id`
   * -family route resolves through this, so a `runId` captured at the start
   * of a Task's execution keeps reflecting that execution's current state —
   * exactly the polling contract the deleted `runs` table gave for free.
   */
  async resolveLatest(id: number): Promise<AttemptRow> {
    const row = await this.get(id);
    const latest = await this.db.read((db) =>
      db.select().from(attempts).where(eq(attempts.taskId, row.taskId)).orderBy(asc(attempts.number)).all(),
    );
    return latest.at(-1) ?? row;
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

function frozenCost(usage: string | null, rawPrices: string | null): string | null {
  if (!usage || !rawPrices) return null;
  return JSON.stringify(costOfUsages([JSON.parse(usage) as RunUsage], JSON.parse(rawPrices) as PriceTable));
}

/** The attempt/card API projection of one Attempt row. Moved from `domain/runs.ts`'s `serializeRun`. */
export function serializeAttempt(attempt: AttemptRow): Record<string, unknown> {
  // liveUsage is the Activity view's snapshot (streamed as `run_usage`), not
  // part of the agent-facing attempt shape.
  const { liveUsage: _liveUsage, ...rest } = attempt;
  return {
    ...rest,
    usage: attempt.usage ? JSON.parse(attempt.usage) : null,
    cost: attempt.cost ? JSON.parse(attempt.cost) : null,
    guardrailConfig: attempt.guardrailConfig ? JSON.parse(attempt.guardrailConfig) : null,
    priceTable: attempt.priceTable ? JSON.parse(attempt.priceTable) : null,
  };
}
