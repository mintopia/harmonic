import { and, asc, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runs, runEvents, tasks, type RunRow, type RunEventRow, type RunState } from '../db/schema.js';
import { DomainError } from './errors.js';
import { RunFactStore } from './run-facts.js';
import { isParkedPhase } from './run-phases.js';
import type { ResolvedGuardrails } from './setting-override.js';
import type { PriceTable } from '../execution/pricing.js';

export interface RunEventInput {
  type: 'session_update' | 'permission_request' | 'lifecycle';
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
}

export class RunStore {
  constructor(private readonly db: Db) {}

  create(taskId: number, snapshot?: RunGuardrailSnapshot, chainId?: number): RunRow {
    const attempt =
      (this.db
        .select({ n: sql<number>`coalesce(max(${runs.attempt}), 0)` })
        .from(runs)
        .where(eq(runs.taskId, taskId))
        .get()?.n ?? 0) + 1;
    return this.db
      .insert(runs)
      .values({
        taskId,
        attempt,
        state: 'running',
        // A Run enters the phase machine at `executing` the moment it is created
        // (issue #114); the drive loop advances it from here.
        phase: 'executing',
        startedAt: Date.now(),
        guardrailConfig: snapshot ? JSON.stringify(snapshot.guardrailConfig) : null,
        priceTable: snapshot ? JSON.stringify(snapshot.priceTable) : null,
        // The Execution Chain (issue #129) this Run joins; null on a caller
        // that hasn't resolved one yet (pre-feature / not-yet-wired paths).
        chainId: chainId ?? null,
      })
      .returning()
      .get();
  }

  get(id: number): RunRow {
    const row = this.db.select().from(runs).where(eq(runs.id, id)).get();
    if (!row) throw new DomainError('not_found', `run ${id} not found`);
    return row;
  }

  listForTask(taskId: number): RunRow[] {
    return this.db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.attempt)).all();
  }

  /** Every Run bound to one durable Session (issue #148), oldest first — the
   * Runs that share the Session's builder worktree across a retry / reject
   * continuation. Session retirement uses this to check no live Run still leases
   * the worktree before removing it. */
  listForSession(sessionRowId: number): RunRow[] {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.sessionRowId, sessionRowId))
      .orderBy(asc(runs.attempt))
      .all();
  }

  update(id: number, patch: Partial<RunRow>): RunRow {
    return this.db.update(runs).set(patch).where(eq(runs.id, id)).returning().get()!;
  }

  /** Terminal transition; ignored if the run already left `running` (e.g. cancelled). */
  finish(id: number, state: Exclude<RunState, 'running'>, patch: Partial<RunRow> = {}): RunRow {
    const current = this.get(id);
    if (current.state !== 'running') return current;
    return this.update(id, { ...patch, state, finishedAt: Date.now() });
  }

  appendEvent(runId: number, event: RunEventInput): PersistedRunEvent {
    const seq =
      (this.db
        .select({ n: sql<number>`coalesce(max(${runEvents.seq}), 0)` })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .get()?.n ?? 0) + 1;
    const row = this.db
      .insert(runEvents)
      .values({ runId, seq, ts: Date.now(), type: event.type, payload: JSON.stringify(event.payload) })
      .returning()
      .get();
    return deserializeEvent(row);
  }

  listEvents(runId: number): PersistedRunEvent[] {
    this.get(runId); // 404 on unknown run
    return this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq))
      .all()
      .map(deserializeEvent);
  }

  /**
   * Actively-executing Run count, for the Auto-Runner's Machine-Ceiling
   * concurrency cap (ADR-0012). A Run parked in `phase:'review'` is
   * `state:'running'` but has no live harness (issue #114), so it consumes no
   * machine resources and is excluded here — otherwise a queue of native Runs
   * awaiting review would throttle the ceiling for no reason (and it restores
   * the pre-phase-machine count, when a native Run left `running` at
   * agent-finish). `phase IS NULL` (a pre-feature running Run) still counts.
   */
  private readonly notReviewParked = or(isNull(runs.phase), ne(runs.phase, 'review'));

  countRunning(): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(runs)
        .where(and(eq(runs.state, 'running'), this.notReviewParked))
        .get()?.n ?? 0
    );
  }

  /**
   * Running-Run count per owning Workspace, for the Auto-Runner's per-Workspace
   * concurrency cap (ADR-0012, issue #60). Runs carry no Workspace column, so
   * the count joins through the Task; the same actively-executing-Run source as
   * {@link countRunning} (review-parked Runs excluded), so the per-Workspace
   * tallies and the Machine-Ceiling total can never disagree. Workspaces with no
   * running Run are absent (read as 0).
   */
  countRunningByWorkspace(): Map<number, number> {
    const rows = this.db
      .select({ workspaceId: tasks.workspaceId, n: sql<number>`count(*)` })
      .from(runs)
      .innerJoin(tasks, eq(runs.taskId, tasks.id))
      .where(and(eq(runs.state, 'running'), this.notReviewParked))
      .groupBy(tasks.workspaceId)
      .all();
    const counts = new Map<number, number>();
    for (const row of rows) if (row.workspaceId != null) counts.set(row.workspaceId, row.n);
    return counts;
  }

  /**
   * Finished runs that never got a per-model usage split — their run-end
   * collection raced the harness's session-log flush. Candidates for the
   * boot-time backfill.
   *
   * "Finished" here means the harness process is gone, not that the Run row is
   * terminal: a native Run parked in `phase:'review'` is `state:'running'` yet
   * its harness has exited and its session log is complete on disk (issue #114),
   * so it is just as backfillable as a settled run. The filter therefore admits
   * any Run that is not terminal-`running`-mid-execution — i.e. non-running rows
   * plus review-parked ones.
   */
  listUsageBackfillCandidates(): RunRow[] {
    return this.db
      .select()
      .from(runs)
      .where(and(ne(runs.state, 'running'), isNotNull(runs.sessionId)))
      .all()
      .concat(
        this.db
          .select()
          .from(runs)
          .where(and(eq(runs.state, 'running'), eq(runs.phase, 'review'), isNotNull(runs.sessionId)))
          .all(),
      )
      .filter((run) => {
        if (!run.usage) return true;
        const models = (JSON.parse(run.usage) as { models?: Record<string, unknown> }).models;
        return !models || Object.keys(models).length === 0;
      });
  }

  /**
   * Crash recovery, run at boot: any run still marked running was orphaned
   * by a restart. Fail it (reason "interrupted") and return it so the
   * caller can fail its task (and notify) — never silently re-run on a
   * possibly dirty working directory.
   *
   * A Run parked in `phase:'review'` is the exception (issue #114): that phase
   * is *defined* by having no live process — it awaits the human accept/reject
   * gate — so a restart did not orphan it. Such Runs are left untouched (they
   * survive the restart still parked, their Task still `awaiting-review`) and are
   * NOT returned. Their Work Context lease was already released at review entry
   * (#114 releases it there; holding it across review awaits #122), so there is
   * nothing for the caller to release either.
   *
   * A Run mid-landing (`phase:'landing'`) is excluded the same way, but for a
   * different reason (issue #117): unlike `review`, `landing` is NOT a parked
   * phase (it does have a live process while running) — a crash there really
   * did orphan it. It's excluded from this blind fail because a landing may
   * already have applied an irreversible effect (a merge, say) before it died,
   * and this sweep has no way to tell — `CrashRecoveryCoordinator`
   * (domain/crash-recovery.ts) reconciles it against its landing journal
   * instead, ahead of this sweep running.
   */
  markInterrupted(): RunRow[] {
    const facts = new RunFactStore(this.db);
    const running = this.db.select().from(runs).where(eq(runs.state, 'running')).all();
    const orphans = running.filter((run) => !isParkedPhase(run.phase) && run.phase !== 'landing');
    for (const run of orphans) {
      // process-death is a `run_fact` too (issue #113, §0.3): the orphan's
      // failed/interrupted terminal stays reconstructable from the log alone.
      facts.append(run.id, 'process-death', {
        runState: 'failed',
        taskAction: 'failed',
        reason: 'interrupted',
      });
      this.update(run.id, { state: 'failed', phase: 'terminal', reason: 'interrupted', finishedAt: Date.now() });
    }
    return orphans;
  }

  /**
   * Runs parked in `phase:'review'` whose review SLA has lapsed as of `now`
   * (issue #114, reliability-design round-5 #4): still `running`, in `review`,
   * with a `reviewDeadline` at or before `now`. The review-SLA sweep settles
   * each to a terminal disposition via the coordinator (a `review-sla-expiry`
   * `run_fact`). A null `reviewDeadline` never expires.
   */
  listReviewParkedOverdue(now: number): RunRow[] {
    return this.db
      .select()
      .from(runs)
      .where(and(eq(runs.state, 'running'), eq(runs.phase, 'review'), isNotNull(runs.reviewDeadline)))
      .all()
      .filter((run) => run.reviewDeadline != null && run.reviewDeadline <= now);
  }

  /**
   * Runs mid-landing when a crash interrupted the process (issue #117):
   * `state:'running', phase:'landing'` — excluded from {@link markInterrupted}'s
   * blind orphan-fail because a landing may already have applied an
   * irreversible effect (see that method's doc comment). The boot-time
   * `CrashRecoveryCoordinator` (domain/crash-recovery.ts) is the sole caller:
   * it reconciles each of these against its landing journal instead.
   */
  listLandingOrphans(): RunRow[] {
    return this.db
      .select()
      .from(runs)
      .where(and(eq(runs.state, 'running'), eq(runs.phase, 'landing')))
      .all();
  }
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
    guardrailConfig: run.guardrailConfig ? JSON.parse(run.guardrailConfig) : null,
    priceTable: run.priceTable ? JSON.parse(run.priceTable) : null,
  };
}
