import type { SpanContext } from '@opentelemetry/api';
import type { AppConfig } from '../config.js';
import type { OrderedEligibleTask, TaskService } from '../domain/tasks.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { TaskRow, WorkspaceRow } from '../db/schema.js';
import { resolveScoped, resolveCap } from '../domain/setting-override.js';
import { workContextKey } from '../domain/work-context-key.js';
import { repoKey } from './repo-lock.js';
import type { GitCircuitBreaker } from './git-failure.js';
import type { Runner } from './runner.js';
import { forEachYielding } from '../reliability/yield.js';
import { startOperation, type Operation } from '../telemetry/operations.js';

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function taskOperationAttributes(task: Pick<TaskRow, 'id' | 'origin' | 'priority' | 'workspaceId'>): Record<string, string | number> {
  return {
    'task.id': task.id,
    'task.origin': task.origin,
    'task.priority': task.priority,
    ...(task.workspaceId == null ? {} : { 'workspace.id': task.workspaceId }),
  };
}

function directContextKey(task: TaskRow): string | undefined {
  if (task.isolationMode !== 'direct') return undefined;
  return workContextKey({ isolationMode: 'direct', workingDir: task.workingDir });
}

function hasAssignedEpicBase(task: TaskRow): boolean {
  return task.baseBranch?.startsWith('epic/') ?? false;
}

async function occupiedDirectContexts(tasks: readonly TaskRow[]): Promise<Map<string, TaskRow>> {
  const occupied = new Map<string, TaskRow>();
  await forEachYielding(tasks, (t) => {
    if (t.state !== 'working') return;
    const key = directContextKey(t);
    if (key && !occupied.has(key)) occupied.set(key, t);
  });
  return occupied;
}

/**
 * The tracker-facing hooks the Auto-Runner consults for mirrored afk Tasks;
 * absent on a native-only server, where every ready Task is pick-eligible.
 */
export interface MirrorClaim {
  /** Post-lock: advertise Harmonic's local claim without reading tracker ownership. */
  advertiseClaim(task: TaskRow): Promise<void>;
}

type RunLauncher = (taskId: Parameters<Runner['launchClaimed']>[0], parent?: SpanContext) => Promise<unknown>;

export interface AutoRunnerOptions {
  mirror?: MirrorClaim;
  epicBaseNotReady?: (task: TaskRow) => boolean | Promise<boolean>;
  gitBreaker?: GitCircuitBreaker;
  /** Fixed scheduler cadence; tests inject a short interval. */
  intervalMs?: number;
  /** How long a confirmed absent assigned integration branch has to recover
   * through tracker reconciliation before the Task is escalated. */
  missingEpicBaseGraceMs?: number;
  /** Injected for deterministic scheduler-time tests. */
  clock?: () => number;
}

const DEFAULT_MISSING_EPIC_BASE_GRACE_MS = 300_000;

/**
 * The scheduler. When enabled, fills free run slots with ready tasks —
 * highest priority first, FIFO by creation time within a priority. `poke()`
 * whenever something may have changed; it coalesces and never re-enters.
 *
 * Concurrency is two-level: the global Machine Ceiling
 * (`config.autoRunner.maxConcurrentAttempts`) caps total concurrent Attempts
 * across all Workspaces, and each Workspace has its own cap clamped to the
 * ceiling. A Task runs only if `master ∧ workspace enabled`, where the
 * per-Workspace enable inherits `master` when unset.
 */
export class AutoRunner {
  private timer: NodeJS.Timeout | undefined;
  private scheduled = false;
  private filling = false;
  private refill = false;
  private readonly mirror: MirrorClaim | undefined;
  private readonly epicBaseNotReady: ((task: TaskRow) => boolean | Promise<boolean>) | undefined;
  private readonly gitBreaker: GitCircuitBreaker | undefined;
  private readonly intervalMs: number;
  private readonly missingEpicBaseGraceMs: number;
  private readonly clock: () => number;
  private schedulerSkipReasons = new Map<number, string>();

  private readonly missingEpicBaseSince = new Map<number, number>();

  private readonly contextWaitingSince = new Map<number, number>();

  constructor(
    private readonly taskService: TaskService,
    private readonly runStore: Pick<AttemptStore, 'countRunning' | 'countRunningByWorkspace'>,
    private readonly runner: { launchClaimed: RunLauncher; escalateUnspawned: Runner['escalateUnspawned'] },
    private readonly getConfig: () => AppConfig,
    private readonly getWorkspaces: () => Promise<WorkspaceRow[]>,
    options: AutoRunnerOptions = {},
  ) {
    this.mirror = options.mirror;
    this.epicBaseNotReady = options.epicBaseNotReady;
    this.gitBreaker = options.gitBreaker;
    this.intervalMs = options.intervalMs ?? 1_000;
    this.missingEpicBaseGraceMs = options.missingEpicBaseGraceMs ?? DEFAULT_MISSING_EPIC_BASE_GRACE_MS;
    this.clock = options.clock ?? Date.now;
  }

  /** Begin the DB-backed scheduler interval. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poke(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The latest scheduler reason for `taskId`, if it was not picked. */
  skipReasonFor(taskId: number): string | undefined {
    return this.schedulerSkipReasons.get(taskId);
  }

  /** When `taskId` started its current House-Rule-blocked streak,
   * or `undefined` if it isn't currently blocked (or hasn't been seen).
   * The "how long has this been waiting" signal for a Work-Context-blocked Task. */
  waitingSince(taskId: number): number | undefined {
    return this.contextWaitingSince.get(taskId);
  }

  poke(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.fill();
    });
  }

  private async fill(): Promise<void> {
    if (this.filling) {
      this.refill = true;
      return;
    }
    this.filling = true;
    let tick: Operation | undefined;
    const tickParent = (): SpanContext =>
      (tick ??= startOperation({ type: 'auto-runner.tick', attributes: {} })).spanContext;
    try {
      do {
        this.refill = false;
        const { enabled: master, maxConcurrentAttempts: ceiling } = this.getConfig().autoRunner;
        const workspacesById = new Map((await this.getWorkspaces()).map((w) => [w.id, w]));
        await this.refreshSkipReasons({ master, ceiling, workspacesById });
        if (!master) break;
        await this.fillSlots(workspacesById, ceiling, tickParent);
        await this.refreshSkipReasons({ master, ceiling, workspacesById });
      } while (this.refill);
      tick?.end();
    } catch (error) {
      tick?.fail(failureReason(error));
    } finally {
      this.filling = false;
    }
  }

  private async startPicked(task: TaskRow, skip: Set<number>, tickParent: () => SpanContext): Promise<boolean> {
    const pick = startOperation({
      type: 'auto-runner.pick-start',
      parent: tickParent(),
      attributes: taskOperationAttributes(task),
    });
    try {
      const started = await pick.run(async () => {
        const claimed = await this.taskService.claimReady(task.id);
        if (!claimed) {
          pick.update({ 'auto-runner.claimed': false });
          skip.add(task.id);
          return false;
        }
        pick.update({ 'auto-runner.claimed': true });
        this.schedulerSkipReasons.delete(task.id);
        this.contextWaitingSince.delete(task.id);
        this.missingEpicBaseSince.delete(task.id);
        if (claimed.origin === 'mirrored' && this.mirror) {
          try {
            await this.mirror.advertiseClaim(claimed);
          } catch {
          }
        }
        try {
          await this.runner.launchClaimed(task.id, pick.spanContext);
          return true;
        } catch (error) {
          pick.fail(failureReason(error));
          await this.taskService.setState(task.id, 'ready');
          skip.add(task.id);
          return false;
        }
      });
      pick.end();
      return started;
    } catch (error) {
      pick.fail(failureReason(error));
      throw error;
    }
  }

  private recordSkipReason(taskId: number, reason: string): void {
    this.schedulerSkipReasons.set(taskId, reason);
  }

  private recordWaiting(taskId: number): void {
    if (!this.contextWaitingSince.has(taskId)) this.contextWaitingSince.set(taskId, Date.now());
  }

  private async refreshSkipReasons({
    master,
    ceiling,
    workspacesById,
  }: {
    master: boolean;
    ceiling: number;
    workspacesById: Map<number, WorkspaceRow>;
  }): Promise<void> {
    const [all, readyWithDeps, running, runningByWorkspace] = await Promise.all([
      this.taskService.list(),
      this.taskService.listWithDeps({ state: 'ready' }),
      this.runStore.countRunning(),
      this.runStore.countRunningByWorkspace(),
    ]);
    const allById = new Map<number, TaskRow>();
    await forEachYielding(all, (task) => {
      allById.set(task.id, task);
    });
    const occupied = await occupiedDirectContexts(all);
    const missingThisPass = new Map<number, number>();
    const next = new Map<number, string>();
    const record = (taskId: number, reason: string) => next.set(taskId, reason);

    const dependencyBlocked = new Set<number>();
    await forEachYielding(readyWithDeps, (task) => {
      if (task.openBlockerCount === 0) return;
      dependencyBlocked.add(task.id);
      const blockers = task.dependsOn.filter((id) => allById.get(id)?.state !== 'done');
      record(
        task.id,
        blockers.length === 0 ? 'blocked by a dependency' : `blocked-by #${blockers.join(', #')}`,
      );
    });

    await forEachYielding(all, async (task) => {
      if (task.state !== 'ready') return;
      if (dependencyBlocked.has(task.id)) return;
      if (!master) {
        record(task.id, 'Auto-Runner disabled');
        return;
      }
      const workspace = task.workspaceId == null ? undefined : workspacesById.get(task.workspaceId);
      if (!resolveScoped('autoRunnerEnabled', workspace?.autoRunnerEnabled, true)) {
        record(task.id, 'workspace disabled');
        return;
      }
      if (running >= ceiling) {
        record(task.id, 'at capacity');
        return;
      }
      const cap = resolveCap(workspace?.maxConcurrentAttempts, ceiling);
      const workspaceRunning = task.workspaceId == null ? 0 : (runningByWorkspace.get(task.workspaceId) ?? 0);
      if (workspaceRunning >= cap) {
        record(task.id, 'at capacity');
        return;
      }
      if (this.gitBreaker && !this.gitBreaker.allows(repoKey(task.workingDir))) {
        record(task.id, 'git workspace-prep backoff (repeated failures on this repo)');
        this.recordWaiting(task.id);
        return;
      }
      if (await this.epicBaseNotReady?.(task)) {
        if (hasAssignedEpicBase(task)) {
          const since = this.missingEpicBaseSince.get(task.id) ?? this.clock();
          if (this.clock() - since >= this.missingEpicBaseGraceMs) {
            const reason = `integration branch ${task.baseBranch} missing for ${Math.round(this.missingEpicBaseGraceMs / 1000)}s`;
            await this.runner.escalateUnspawned(task.id, reason);
            record(task.id, `${reason}, escalated to human`);
            return;
          }
          missingThisPass.set(task.id, since);
        }
        record(task.id, 'integration branch missing');
        return;
      }
      const key = directContextKey(task);
      const holder = key ? occupied.get(key) : undefined;
      if (holder) {
        record(task.id, `Work Context held by task ${holder.id} (${holder.state})`);
        this.recordWaiting(task.id);
      }
    });
    this.schedulerSkipReasons = next;
    this.missingEpicBaseSince.clear();
    await forEachYielding(missingThisPass, ([taskId, since]) => {
      this.missingEpicBaseSince.set(taskId, since);
    });
    await forEachYielding(this.contextWaitingSince.keys(), (taskId) => {
      if (!this.schedulerSkipReasons.has(taskId)) this.contextWaitingSince.delete(taskId);
    });
  }

  private async fillSlots(
    workspacesById: Map<number, WorkspaceRow>,
    ceiling: number,
    tickParent: () => SpanContext,
  ): Promise<void> {
    const skip = new Set<number>();
    const [all, ordered, running0, runningByWorkspace0] = await Promise.all([
      this.taskService.list(),
      this.taskService.orderedEligibleWork(),
      this.runStore.countRunning(),
      this.runStore.countRunningByWorkspace(),
    ]);
    let running = running0;
    const runningByWorkspace = new Map(runningByWorkspace0);
    const occupied = await occupiedDirectContexts(all);
    const epicGate = new Map<number, boolean>();
    if (this.epicBaseNotReady) {
      const gate = this.epicBaseNotReady;
      await forEachYielding(all, async (t) => {
        if (t.state === 'ready' && t.origin === 'mirrored' && !skip.has(t.id)) {
          epicGate.set(t.id, await gate(t));
        }
      });
    }

    for (const task of ordered) {
      if (running >= ceiling) break;
      if (!this.slotCandidate(task, { skip, workspacesById, runningByWorkspace, ceiling, occupied, epicGate })) {
        continue;
      }
      const started = await this.startPicked(task, skip, tickParent);
      if (!started) continue;
      running += 1;
      if (task.workspaceId != null) {
        runningByWorkspace.set(task.workspaceId, (runningByWorkspace.get(task.workspaceId) ?? 0) + 1);
      }
      const key = directContextKey(task);
      if (key && !occupied.has(key)) occupied.set(key, { ...task, state: 'working' });
    }

    await forEachYielding(this.contextWaitingSince.keys(), (taskId) => {
      if (!this.schedulerSkipReasons.has(taskId)) this.contextWaitingSince.delete(taskId);
    });
  }

  private slotCandidate(
    t: OrderedEligibleTask,
    {
      skip,
      workspacesById,
      runningByWorkspace,
      ceiling,
      occupied,
      epicGate,
    }: {
      skip: Set<number>;
      workspacesById: Map<number, WorkspaceRow>;
      runningByWorkspace: Map<number, number>;
      ceiling: number;
      occupied: Map<string, TaskRow>;
      epicGate: Map<number, boolean>;
    },
  ): boolean {
    if (t.state !== 'ready' || skip.has(t.id)) return false;
    if (epicGate.get(t.id)) return false;
    const workspace = t.workspaceId != null ? workspacesById.get(t.workspaceId) : undefined;
    if (!resolveScoped('autoRunnerEnabled', workspace?.autoRunnerEnabled, true)) return false;
    const cap = resolveCap(workspace?.maxConcurrentAttempts, ceiling);
    const wsRunning = t.workspaceId != null ? (runningByWorkspace.get(t.workspaceId) ?? 0) : 0;
    if (wsRunning >= cap) return false;
    if (this.gitBreaker && !this.gitBreaker.allows(repoKey(t.workingDir))) {
      this.recordSkipReason(t.id, 'git workspace-prep backoff (repeated failures on this repo)');
      this.recordWaiting(t.id);
      return false;
    }
    const key = directContextKey(t);
    const holder = key ? occupied.get(key) : undefined;
    if (holder) {
      this.recordSkipReason(t.id, `Work Context held by task ${holder.id} (${holder.state})`);
      this.recordWaiting(t.id);
      return false;
    }
    return true;
  }
}
