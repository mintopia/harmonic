import { eq } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { scheduledJobs, type ScheduledJobRow } from '../db/schema.js';
import { forEachYielding, yieldToEventLoop } from '../reliability/yield.js';
import { singleFlight } from '../reliability/single-flight.js';
import { startOperation } from '../telemetry/operations.js';

export type ScheduledJobStatus = 'active' | 'disabled';

export interface ScheduledJobSnapshot {
  jobKey: string;
  name: string;
  workspaceId: number | null;
  intervalMs: number;
  status: ScheduledJobStatus;
  lastRunAt: number | null;
  lastStatus: 'ok' | 'error' | null;
  lastDurationMs: number | null;
  lastError: string | null;
  /**
   * The OTel span id of this Job's most recent firing in *this process*
   * (ADR-0010). Deliberately not persisted: spans reset on restart, so a
   * durable id would go dead the moment the process that opened it exits.
   * Null until the Job has fired at least once since boot.
   */
  lastOperationSpanId: string | null;
  nextRunAt: number | null;
}

export interface ScheduledJobRegistration {
  name: string;
  intervalMs: number;
  workspaceId?: number | undefined;
  run: () => Promise<void>;
  enabled?: () => boolean | Promise<boolean>;
}

interface RegisteredJob extends ScheduledJobRegistration {
  jobKey: string;
  timer: NodeJS.Timeout | undefined;
  running: boolean;
  tick: () => Promise<void>;
}

function jobKey(name: string, workspaceId: number | undefined): string {
  return `${name}:${workspaceId ?? 'global'}`;
}

/**
 * Central owner of recurring background work (ADR-0010). Each registered job
 * has one timer and a local running latch, so slow work cannot overlap itself.
 */
export class Scheduler {
  private readonly jobs = new Map<string, RegisteredJob>();
  /** Firing span id per Job, this process only (ADR-0010) — see {@link ScheduledJobSnapshot.lastOperationSpanId}. */
  private readonly lastSpanId = new Map<string, string>();
  private started = false;

  constructor(
    private readonly db: AsyncDbHandle,
    private readonly onChanged: (snapshot: ScheduledJobSnapshot[]) => void = () => {},
    private readonly clock: () => number = Date.now,
  ) {}

  register(registration: ScheduledJobRegistration): () => void {
    const key = jobKey(registration.name, registration.workspaceId);
    if (this.jobs.has(key)) throw new Error(`Scheduled Job already registered: ${key}`);
    if (!(registration.intervalMs > 0)) throw new Error(`Scheduled Job interval must be positive: ${registration.name}`);
    const job: RegisteredJob = {
      ...registration,
      jobKey: key,
      timer: undefined,
      running: false,
      tick: () => Promise.resolve(),
    };
    job.tick = singleFlight(() => this.tickOnce(job));
    this.jobs.set(key, job);
    if (this.started) this.startJob(job);
    void this.emitChanged().catch(() => {});
    return () => {
      if (this.jobs.get(key) !== job) return;
      if (job.timer) clearInterval(job.timer);
      this.jobs.delete(key);
      void this.emitChanged().catch(() => {});
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const job of this.jobs.values()) this.startJob(job);
    void this.emitChanged().catch(() => {});
  }

  stop(): void {
    this.started = false;
    for (const job of this.jobs.values()) {
      if (job.timer) clearInterval(job.timer);
      job.timer = undefined;
    }
  }

  /** Request an immediate Job pass through the same single-flight/recording path as its timer. */
  async runNow(name: string, workspaceId?: number): Promise<void> {
    await this.jobs.get(jobKey(name, workspaceId))?.tick();
  }

  /** Remove durable facts for Jobs no longer registered in this process. */
  async prune(): Promise<void> {
    const live = new Set(this.jobs.keys());
    const rows = await this.db.read((d) => d.select({ jobKey: scheduledJobs.jobKey }).from(scheduledJobs).all());
    await forEachYielding(rows, async (row) => {
      if (!live.has(row.jobKey)) await this.db.write((d) => d.delete(scheduledJobs).where(eq(scheduledJobs.jobKey, row.jobKey)).run());
    });
  }

  async snapshot(): Promise<ScheduledJobSnapshot[]> {
    const persisted = await this.db.read((d) => d.select().from(scheduledJobs).all());
    const byKey = new Map(persisted.map((row) => [row.jobKey, row]));
    const snapshots: ScheduledJobSnapshot[] = [];
    // Registry membership can grow with Workspaces. Yield while materialising
    // the public snapshot so a large fleet never monopolises Node's event loop.
    await forEachYielding(this.jobs.values(), async (job) => {
      snapshots.push(await this.toSnapshot(job, byKey.get(job.jobKey)));
    });
    return snapshots.sort((a, b) => a.jobKey.localeCompare(b.jobKey));
  }

  private startJob(job: RegisteredJob): void {
    if (job.timer) return;
    job.timer = setInterval(() => this.fire(job), job.intervalMs);
    job.timer.unref?.();
    void this.runIfDueOnStart(job).catch(() => {});
  }

  private async tickOnce(job: RegisteredJob): Promise<void> {
    if (!(await this.isEnabled(job))) {
      await this.emitChanged();
      return;
    }
    job.running = true;
    const startedAt = this.clock();
    // The firing span (ADR-0010): every registry row links to the Operation
    // that produced its last run. A Job that opens its own internal spans
    // (poll, session retirement, worktree reconcile, …) nests under this one.
    const firing = startOperation({ type: 'harmonic.job', attributes: { job: job.name, workspace: job.workspaceId ?? undefined } });
    this.lastSpanId.set(job.jobKey, firing.spanContext.spanId);
    try {
      // Yield on both sides of externally-supplied work. Job implementations
      // that iterate growing collections still own their inner yielding, but
      // Scheduler orchestration itself never chains a synchronous tick burst.
      await yieldToEventLoop();
      await firing.run(() => job.run());
      firing.end();
      await this.record(job, startedAt, 'ok', null);
    } catch (error) {
      firing.fail(error);
      await this.record(job, startedAt, 'error', error instanceof Error ? error.message : String(error));
    } finally {
      job.running = false;
      await yieldToEventLoop();
      await this.emitChanged();
    }
  }

  private async record(
    job: RegisteredJob,
    startedAt: number,
    status: 'ok' | 'error',
    error: string | null,
  ): Promise<void> {
    const row = {
      jobKey: job.jobKey,
      name: job.name,
      workspaceId: job.workspaceId ?? null,
      lastRunAt: startedAt,
      lastStatus: status,
      lastDurationMs: Math.max(0, this.clock() - startedAt),
      lastError: error,
    };
    await this.db.write((d) =>
      d.insert(scheduledJobs)
        .values(row)
        .onConflictDoUpdate({ target: scheduledJobs.jobKey, set: row })
        .run(),
    );
  }

  private async runIfDueOnStart(job: RegisteredJob): Promise<void> {
    const row = await this.db.read((d) => d.select().from(scheduledJobs).where(eq(scheduledJobs.jobKey, job.jobKey)).get());
    if (row?.lastRunAt === undefined || row.lastRunAt === null || row.lastRunAt + job.intervalMs <= this.clock()) await job.tick();
  }

  private fire(job: RegisteredJob): void {
    void job.tick().catch(() => {});
  }

  private async isEnabled(job: RegisteredJob): Promise<boolean> {
    return (await job.enabled?.()) ?? true;
  }

  private async toSnapshot(job: RegisteredJob, row: ScheduledJobRow | undefined): Promise<ScheduledJobSnapshot> {
    const enabled = await this.isEnabled(job);
    const lastRunAt = row?.lastRunAt ?? null;
    return {
      jobKey: job.jobKey,
      name: job.name,
      workspaceId: job.workspaceId ?? null,
      intervalMs: job.intervalMs,
      status: enabled ? 'active' : 'disabled',
      lastRunAt,
      lastStatus: row?.lastStatus ?? null,
      lastDurationMs: row?.lastDurationMs ?? null,
      lastError: row?.lastError ?? null,
      lastOperationSpanId: this.lastSpanId.get(job.jobKey) ?? null,
      nextRunAt: enabled ? (lastRunAt === null ? this.clock() : lastRunAt + job.intervalMs) : null,
    };
  }

  private async emitChanged(): Promise<void> {
    this.onChanged(await this.snapshot());
  }
}
