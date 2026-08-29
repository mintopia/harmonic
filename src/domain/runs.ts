import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { runs, runEvents, runToolCalls, tasks, type RunRow, type RunEventRow, type RunState } from '../db/schema.js';
import { DomainError } from './errors.js';
import type { ResolvedGuardrails } from './setting-override.js';
import { costOfUsages, type PriceTable } from '../execution/pricing.js';
import type { RunUsage } from '../execution/usage.js';
import { forEachYielding } from '../reliability/yield.js';

export interface RunEventInput {
  /** ACP transcript updates are deliberately never durable. See ADR-0031. */
  type: 'permission_request' | 'lifecycle';
  payload: unknown;
}

/** The Guardrail state a Run captures at start (issue #126): the effective
 * config and price table, frozen so a later change can't retroactively trip it. */
export interface RunGuardrailSnapshot {
  guardrailConfig: ResolvedGuardrails;
  priceTable: PriceTable;
}

export interface PersistedRunEvent {
  id: number;
  runId: number;
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

export class RunStore {
  constructor(private readonly db: AsyncDbHandle) {}

  async create(taskId: number, snapshot?: RunGuardrailSnapshot): Promise<RunRow> {
    // read-then-insert as one write-queue unit: under the async single-writer
    // queue the attempt# CAS would otherwise race a concurrent create for the
    // same Task (ADR-0029 §3; the sync driver gave this for free).
    return this.db.write(async (db) => {
      const attempt =
        ((
          await db
            .select({ n: sql<number>`coalesce(max(${runs.attempt}), 0)` })
            .from(runs)
            .where(eq(runs.taskId, taskId))
            .get()
        )?.n ?? 0) + 1;
      return db
        .insert(runs)
        .values({
          taskId,
          attempt,
          state: 'running',
          startedAt: Date.now(),
          guardrailConfig: snapshot ? JSON.stringify(snapshot.guardrailConfig) : null,
          priceTable: snapshot ? JSON.stringify(snapshot.priceTable) : null,
        })
        .returning()
        .get();
    });
  }

  async get(id: number): Promise<RunRow> {
    const row = await this.db.read((db) => db.select().from(runs).where(eq(runs.id, id)).get());
    if (!row) throw new DomainError('not_found', `run ${id} not found`);
    return row;
  }

  async assertExists(id: number): Promise<void> {
    await this.get(id);
  }

  listForTask(taskId: number): Promise<RunRow[]> {
    return this.db.read((db) =>
      db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.attempt)).all(),
    );
  }

  /** Runs for a task list, ordered as `listForTask` orders each task's Runs. */
  async listForTasks(taskIds: number[]): Promise<RunRow[]> {
    if (taskIds.length === 0) return [];
    return this.db.read((db) =>
      db.select().from(runs).where(inArray(runs.taskId, taskIds)).orderBy(asc(runs.taskId), asc(runs.attempt)).all(),
    );
  }

  /** Every Run row, unfiltered. Branch retirement scans it to find
   * Runs to retire. */
  listAll(): Promise<RunRow[]> {
    return this.db.read((db) => db.select().from(runs).all());
  }

  /** Every running Run. Its builder and disposable verification worktrees are
   * live until the Run settles, even when no durable Session owns them. */
  listAllRunning(): Promise<RunRow[]> {
    return this.db.read((db) => db.select().from(runs).where(eq(runs.state, 'running')).all());
  }

  /** Every Run bound to one durable Session (issue #148), oldest first — the
   * Runs that share the Session's builder worktree across a retry / reject
   * continuation. Session retirement uses this to check no live Run of the Session
   * is still active (`running`). */
  listForSession(sessionRowId: number): Promise<RunRow[]> {
    return this.db.read((db) =>
      db.select().from(runs).where(eq(runs.sessionRowId, sessionRowId)).orderBy(asc(runs.attempt)).all(),
    );
  }

  update(id: number, patch: Partial<RunRow>): Promise<RunRow> {
    return this.db.write((db) =>
      db.update(runs).set(patch).where(eq(runs.id, id)).returning().get(),
    ) as Promise<RunRow>;
  }

  /** Write a final Usage and its Cost atomically. Once present, Cost never changes. */
  async updateWithFrozenCost(id: number, patch: Partial<RunRow>): Promise<RunRow> {
    return this.db.write(async (db) => {
      const current = await db.select().from(runs).where(eq(runs.id, id)).get();
      if (!current) throw new DomainError('not_found', `run ${id} not found`);
      const usage = patch.usage ?? current.usage;
      const cost = current.cost ?? patch.cost ?? frozenCost(usage, current.priceTable);
      return db.update(runs).set({ ...patch, cost }).where(eq(runs.id, id)).returning().get();
    });
  }

  /** One deliberate migration backfill for Runs that predate stored Cost. */
  async backfillCosts(fallbackPrices: PriceTable): Promise<void> {
    const candidates = await this.db.read((db) =>
      db
        .select()
        .from(runs)
        .where(and(isNull(runs.cost), isNotNull(runs.usage), ne(runs.state, 'running')))
        .all(),
    );
    await forEachYielding(candidates, async (run) => {
      // Pre-ADR Runs were priced from the live table on every read. The one
      // deliberate backfill preserves that last visible value, rather than
      // applying their old guardrail snapshot.
      const cost = frozenCost(run.usage, JSON.stringify(fallbackPrices));
      if (cost === null) return;
      await this.db.write((db) => db.update(runs).set({ cost }).where(and(eq(runs.id, run.id), isNull(runs.cost))).run());
    });
  }

  /**
   * Remove a Run row (used to simulate/handle a Run row removed out from under
   * the Runner mid-flight).
   */
  async delete(id: number): Promise<void> {
    await this.db.write((db) => db.delete(runs).where(eq(runs.id, id)).run());
  }

  /** Terminal transition; ignored if the run already left `running` (e.g. cancelled). */
  async finish(id: number, state: Exclude<RunState, 'running'>, patch: Partial<RunRow> = {}): Promise<RunRow> {
    // The read-guard-then-update runs as one write-queue unit so the terminal
    // transition can't race another writer between the state check and the write.
    return this.db.write(async (db) => {
      const current = await db.select().from(runs).where(eq(runs.id, id)).get();
      if (!current) throw new DomainError('not_found', `run ${id} not found`);
      if (current.state !== 'running') return current;
      return db
        .update(runs)
        .set({ ...patch, state, finishedAt: Date.now() })
        .where(eq(runs.id, id))
        .returning()
        .get();
    });
  }

  async appendEvent(runId: number, event: RunEventInput): Promise<PersistedRunEvent> {
    // read-then-insert as one write-queue unit — the `seq` CAS mirrors
    // VerificationAttemptStore.append and would collide under naive concurrent
    // appends (ADR-0029 §3).
    const row = await this.db.write(async (db) => {
      const seq =
        ((
          await db
            .select({ n: sql<number>`coalesce(max(${runEvents.seq}), 0)` })
            .from(runEvents)
            .where(eq(runEvents.runId, runId))
            .get()
        )?.n ?? 0) + 1;
      return db
        .insert(runEvents)
        .values({ runId, seq, ts: Date.now(), type: event.type, payload: JSON.stringify(event.payload) })
        .returning()
        .get();
    });
    return deserializeEvent(row);
  }

  async listEvents(runId: number): Promise<PersistedRunEvent[]> {
    await this.get(runId); // 404 on unknown run
    const rows = await this.db.read((db) =>
      db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.seq)).all(),
    );
    return rows.map(deserializeEvent);
  }

  /** Per-Run tool-call snapshot, overwritten by the Runner's in-memory rollup
   * on the ADR-0010 coarse cadence and when a turn finishes (ADR-0031). */
  async replaceToolCalls(runId: number, totals: ReadonlyMap<string, number>): Promise<void> {
    await this.db.write(async (db) => {
      await db.delete(runToolCalls).where(eq(runToolCalls.runId, runId)).run();
      const rows = [...totals].map(([toolName, count]) => ({ runId, toolName, count }));
      if (rows.length > 0) await db.insert(runToolCalls).values(rows).run();
    });
  }

  async listToolCalls(runId: number): Promise<Map<string, number>> {
    const rows = await this.db.read((db) =>
      db.select({ toolName: runToolCalls.toolName, count: runToolCalls.count }).from(runToolCalls).where(eq(runToolCalls.runId, runId)).all(),
    );
    return new Map(rows.map(({ toolName, count }) => [toolName, count]));
  }

  /** Total persisted tool calls for each supplied Run, for board list serialization. */
  async toolCallCounts(runIds: number[]): Promise<Map<number, number>> {
    if (runIds.length === 0) return new Map();
    const rows = await this.db.read((db) =>
      db
        .select({ runId: runToolCalls.runId, count: sql<number>`sum(${runToolCalls.count})` })
        .from(runToolCalls)
        .where(inArray(runToolCalls.runId, runIds))
        .groupBy(runToolCalls.runId)
        .all(),
    );
    return new Map(rows.map(({ runId, count }) => [runId, count]));
  }

  /** Actively-executing Run count, for the Auto-Runner's Machine-Ceiling concurrency cap (ADR-0012). */
  async countRunning(): Promise<number> {
    const row = await this.db.read((db) =>
      db
        .select({ n: sql<number>`count(*)` })
        .from(runs)
        .where(eq(runs.state, 'running'))
        .get(),
    );
    return row?.n ?? 0;
  }

  /** The Runs that consume Machine-Ceiling capacity — the same predicate as
   * {@link countRunning}, so Activity cannot silently diverge from scheduling. */
  async listRunning(): Promise<RunRow[]> {
    return this.db.read((db) => db.select().from(runs).where(eq(runs.state, 'running')).all());
  }

  /**
   * Running-Run count per owning Workspace, for the Auto-Runner's per-Workspace
   * concurrency cap (ADR-0012, issue #60). Runs carry no Workspace column, so
   * the count joins through the Task; the same source as {@link countRunning},
   * so the per-Workspace tallies and the Machine-Ceiling total can never
   * disagree. Workspaces with no running Run are absent (read as 0).
   */
  async countRunningByWorkspace(): Promise<Map<number, number>> {
    const rows = await this.db.read((db) =>
      db
        .select({ workspaceId: tasks.workspaceId, n: sql<number>`count(*)` })
        .from(runs)
        .innerJoin(tasks, eq(runs.taskId, tasks.id))
        .where(eq(runs.state, 'running'))
        .groupBy(tasks.workspaceId)
        .all(),
    );
    const counts = new Map<number, number>();
    for (const row of rows) if (row.workspaceId != null) counts.set(row.workspaceId, row.n);
    return counts;
  }

  /**
   * Finished runs that never got a per-model usage split — their run-end
   * collection raced the harness's session-log flush. Candidates for the
   * boot-time backfill.
   */
  listUsageBackfillCandidates(): Promise<RunRow[]> {
    return this.db.read(async (db) => {
      const finished = await db
        .select()
        .from(runs)
        .where(and(ne(runs.state, 'running'), isNotNull(runs.sessionId)))
        .all();
      return finished.filter((run) => {
        if (!run.usage) return true;
        const models = (JSON.parse(run.usage) as { models?: Record<string, unknown> }).models;
        return !models || Object.keys(models).length === 0;
      });
    });
  }

  /**
   * Crash recovery, run at boot: any run still marked running was orphaned
   * by a restart. Fail it (reason "interrupted") and return it so the
   * caller can fail its task (and notify) — never silently re-run on a
   * possibly dirty working directory.
   *
   * Sole caller: `CrashRecoveryCoordinator.reconcile` (domain/crash-recovery.ts),
   * always as its second pass — a worktree-mode Run whose merge already landed
   * (per `git merge-base --is-ancestor`) is settled directly by that first pass
   * and so is no longer `running` by the time this runs (ADR-0001: crash
   * recovery relies on git's own idempotence, not a journal).
   */
  async markInterrupted(): Promise<RunRow[]> {
    // Boot-only invariant: the sync predecessor was atomic across the whole
    // sweep; the async version reads the `running` set once, then fails each
    // orphan in its own transaction, so a concurrent writer could in principle
    // mutate a row between the read and its compensating write. Safe today
    // because the sole caller (`CrashRecoveryCoordinator.reconcile`) runs once at
    // boot, before any dispatch starts. A periodic caller would need a re-read
    // guard (only fail a run still `running`) added here.
    const orphans = await this.db.read((db) => db.select().from(runs).where(eq(runs.state, 'running')).all());
    for (const run of orphans) {
      await this.db.write((db) =>
        db
          .update(runs)
          .set({ state: 'failed', reason: 'interrupted', finishedAt: Date.now() })
          .where(eq(runs.id, run.id))
          .run(),
      );
    }
    return orphans;
  }

}

function frozenCost(usage: string | null, rawPrices: string | null): string | null {
  if (!usage || !rawPrices) return null;
  return JSON.stringify(costOfUsages([JSON.parse(usage) as RunUsage], JSON.parse(rawPrices) as PriceTable));
}

export function deserializeEvent(row: RunEventRow): PersistedRunEvent {
  return { ...row, payload: JSON.parse(row.payload) };
}

export function serializeRun(run: RunRow): Record<string, unknown> {
  // liveUsage is the Activity view's snapshot (streamed as `run_usage`), not
  // part of the agent-facing run shape.
  const { liveUsage: _liveUsage, ...rest } = run;
  return {
    ...rest,
    usage: run.usage ? JSON.parse(run.usage) : null,
    cost: run.cost ? JSON.parse(run.cost) : null,
    guardrailConfig: run.guardrailConfig ? JSON.parse(run.guardrailConfig) : null,
    priceTable: run.priceTable ? JSON.parse(run.priceTable) : null,
  };
}
