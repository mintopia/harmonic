import type { AttemptRow, WorkspaceRow } from '../db/schema.js';
import type { BudgetGuardrail } from '../config.js';
import type { ResolvedGuardrails } from '../domain/setting-override.js';
import { hasWorkspaceOverride } from '../domain/settings-registry.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { GuardrailEventStore, GuardrailEventInput } from '../domain/guardrail-events.js';
import {
  wallClockBudgetMs,
  wallClockTrip,
  formatBudgetReason,
  formatUnmeasurableReason,
  countsTowardExecutionBudget,
  spendTrip,
  toMicroUsd,
} from '../domain/guardrail-budget.js';
import { detectStall, type ProgressEvent } from '../domain/stall-detector.js';
import { formatProgressReason } from '../domain/guardrail-progress.js';
import {
  toolTimeoutBudgetMs,
  toolTimeoutTrip,
  formatToolTimeoutReason,
} from '../domain/guardrail-tool-timeout.js';
import { totalTokensOf, type AttemptUsageSnapshot } from './usage.js';
import { costOfUsages, type PriceTable } from '../domain/pricing.js';

/** The single nudge the progress Guardrail delivers through the steer channel
 * on a first detected stall before it trips. */
export const PROGRESS_NUDGE_TEXT =
  'You appear to be repeating the same step without making progress. Stop, re-read the task and the most ' +
  'recent error or result, and try a genuinely different approach — or finish if the work is already done.';

type GuardrailWorkspace = Pick<WorkspaceRow, 'guardrailBudget' | 'guardrailProgress'>;

/** The collaborators the supervisor reads, narrowed to the methods the guardrails touch. */
export interface GuardrailDeps {
  attempts: Pick<AttemptStore, 'get' | 'currentStepType'>;
  guardrailEvents: Pick<GuardrailEventStore, 'append'>;
  getWorkspace?: ((workspaceId: number | null) => Promise<GuardrailWorkspace | undefined>) | undefined;
  /** The live-usage snapshot for the spend poll: the spend guard advances the
   * reader itself so a budget trip never lags the real spend. */
  sampleSnapshot: (attemptId: number) => Promise<AttemptUsageSnapshot | null>;
  spendPollMs: number;
  spendGraceMs: number;
}

/** The per-turn seam back into the drive loop's live state: which Attempt is
 * running, the progress trace being accumulated, and the effects a trip applies. */
export interface GuardrailTurn {
  taskId: number;
  workspaceId: number | null;
  attemptId: number;
  attemptNumber: number;
  /** The bounded, reduced progress trace the drive loop pushes ACP events onto. */
  progressTrace: ProgressEvent[];
  /** The single running Attempt a trip's evidence is appended against. */
  attemptForTrip: () => Promise<AttemptRow>;
  /** The latest unpaired tool action, retained even when its surrounding trace
   * ages out (preserves the progress guardrail's slow-tool suspension). */
  outstandingAction: () => ProgressEvent | undefined;
  record: (payload: unknown) => void;
  /** Claim the settle (so the drive loop's own settle no-ops) and coordinate the
   * `guardrail-trip` → Escalation disposition. */
  settle: (now: AttemptRow, reason: string) => Promise<void>;
  /** Interrupt the in-flight `driver.prompt()` / verifier so `driveOnce` unwinds. */
  abort: () => void;
  /** SIGKILL the harness. */
  kill: () => void;
  isSettled: () => boolean;
  /** The agent signalled finish/escalate — a completing turn must not be tripped. */
  isFinishing: () => boolean;
  hasPendingSteer: () => boolean;
  pushSteer: (text: string) => void;
}

/**
 * Owns the four execution Guardrails for one builder turn: the wall-clock
 * deadline, the token/cost spend poll, the hard tool-timeout watchdog, and the
 * stall/loop progress detector. Each trips by the same recipe — append
 * `guardrail_events` evidence, record a `guardrail-tripped` lifecycle event,
 * then settle (first-writer-wins). {@link prime} resolves the Attempt's start
 * snapshot once, the `arm*` methods start the timers, and {@link disarm}
 * clears them. The `evaluate*` methods are the per-fire trip bodies the
 * timers call, public so the trip logic is unit-testable directly.
 */
export class GuardrailSupervisor {
  private startedAt = 0;
  private budget: BudgetGuardrail | null = null;
  private priceTable: PriceTable = {};
  private budgetConfigSource: 'default' | 'workspace' = 'default';
  private progressEnabled = false;
  private progressConfigSource: 'default' | 'workspace' = 'default';
  private toolTimeoutMs: number | null = null;

  private wallClockTimer: ReturnType<typeof setTimeout> | null = null;
  private spendTimer: ReturnType<typeof setInterval> | null = null;
  private toolTimeoutTimer: ReturnType<typeof setInterval> | null = null;
  private spendSampling = false;
  private unmeasurableSince: number | null = null;
  private progressNudged = false;
  private readonly outstandingTools = new Map<string, { startedAt: number; title: string | null }>();

  constructor(
    private readonly deps: GuardrailDeps,
    private readonly turn: GuardrailTurn,
  ) {}

  /**
   * Resolve the Attempt's immutable start snapshot once — the frozen
   * budget/price table, the progress toggle, the tool-timeout bound, and each
   * dimension's `configSource` provenance.
   */
  async prime(): Promise<void> {
    const started = await this.deps.attempts.get(this.turn.attemptId);
    this.startedAt = started.startedAt;
    const config = started.guardrailConfig ? (JSON.parse(started.guardrailConfig) as ResolvedGuardrails) : null;
    this.budget = config?.budget ?? null;
    this.priceTable = started.priceTable ? (JSON.parse(started.priceTable) as PriceTable) : {};
    const ws = await this.deps.getWorkspace?.(this.turn.workspaceId);
    this.budgetConfigSource = hasWorkspaceOverride('guardrailBudget', ws?.guardrailBudget) ? 'workspace' : 'default';
    this.progressEnabled = config?.progress === true;
    this.progressConfigSource = hasWorkspaceOverride('guardrailProgress', ws?.guardrailProgress) ? 'workspace' : 'default';
    this.toolTimeoutMs = this.progressEnabled && config ? toolTimeoutBudgetMs(config.toolTimeoutMinutes) : null;
  }

  /** Arm the wall-clock deadline for the Attempt's remaining execution budget. No-op with no snapshot. */
  armWallClock(): void {
    if (!this.budget) return;
    const remaining = Math.max(0, wallClockBudgetMs(this.budget) - (Date.now() - this.startedAt));
    this.wallClockTimer = setTimeout(() => {
      this.wallClockTimer = null;
      void this.evaluateWallClock();
    }, remaining);
    this.wallClockTimer.unref?.();
  }

  /** Arm the token/cost spend poll; a no-op when neither `tokens` nor `costUsd`
   * is configured on the frozen budget. */
  armSpend(): void {
    if (!this.budget) return;
    if (this.budget.tokens == null && this.budget.costUsd == null) return;
    this.spendTimer = setInterval(() => {
      if (this.spendSampling) return;
      this.spendSampling = true;
      void this.evaluateSpend().finally(() => {
        this.spendSampling = false;
      });
    }, this.deps.spendPollMs);
    this.spendTimer.unref?.();
  }

  /** Arm the hard tool-timeout watchdog; a no-op when the progress Guardrail is off. */
  armToolTimeout(): void {
    if (!this.toolTimeoutMs) return;
    const period = Math.max(1_000, Math.min(this.toolTimeoutMs, 30_000));
    this.toolTimeoutTimer = setInterval(() => void this.evaluateToolTimeout(), period);
    this.toolTimeoutTimer.unref?.();
  }

  /** Disarm every timer. */
  disarm(): void {
    if (this.wallClockTimer) clearTimeout(this.wallClockTimer);
    if (this.toolTimeoutTimer) clearInterval(this.toolTimeoutTimer);
    if (this.spendTimer) clearInterval(this.spendTimer);
    this.wallClockTimer = null;
    this.toolTimeoutTimer = null;
    this.spendTimer = null;
  }

  /** Track tool-call liveness off the ACP `session/update` stream. The watchdog
   * trips on the OLDEST still-open call, so a burst of concurrent tools is
   * bounded by the first to hang. */
  observeTool(update: unknown): void {
    if (!this.toolTimeoutMs) return;
    const u = update as {
      sessionUpdate?: string;
      toolCallId?: unknown;
      title?: unknown;
      kind?: unknown;
      status?: unknown;
    };
    const id = typeof u?.toolCallId === 'string' ? u.toolCallId : null;
    if (!id) return;
    if (u.sessionUpdate === 'tool_call') {
      const title = typeof u.title === 'string' ? u.title : typeof u.kind === 'string' ? u.kind : null;
      this.outstandingTools.set(id, { startedAt: Date.now(), title });
    } else if (u.sessionUpdate === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed')) {
      this.outstandingTools.delete(id);
    }
  }

  /** One wall-clock watchdog fire. A trip only counts while a Step is actively running. */
  async evaluateWallClock(): Promise<void> {
    if (!this.budget) return;
    if (this.turn.isSettled()) return;
    const now = await this.deps.attempts.get(this.turn.attemptId);
    if (now.state !== 'running') return;
    const stepType = await this.deps.attempts.currentStepType(this.turn.taskId, this.turn.attemptNumber);
    if (!stepType) return;
    const trip = wallClockTrip({ elapsedMs: Date.now() - now.startedAt, stepType, budget: this.budget });
    if (!trip) return;
    await this.appendAndSettle(
      now,
      { dimension: trip.dimension, limitValue: trip.limitMs, observedValue: trip.observedMs, configSource: this.budgetConfigSource },
      formatBudgetReason(trip),
    );
    this.turn.abort();
    this.turn.kill();
  }

  /** One spend-poll iteration: read the live snapshot, evaluate tokens/cost
   * against the frozen budget, and trip (or hold through the unmeasurable grace). */
  async evaluateSpend(): Promise<void> {
    if (!this.budget) return;
    if (this.turn.isSettled()) return;
    const now = await this.deps.attempts.get(this.turn.attemptId);
    if (now.state !== 'running') return;
    const stepType = await this.deps.attempts.currentStepType(this.turn.taskId, this.turn.attemptNumber);
    const snap = await this.deps.sampleSnapshot(this.turn.attemptId);
    const observedTokens = snap ? totalTokensOf(snap.usage) : null;
    const cost = snap ? costOfUsages([snap.usage], this.priceTable) : null;
    const observedUsd = cost?.totalUsd ?? null;
    const costIncomplete = cost?.incomplete ?? true;
    const outcome = spendTrip({ stepType, budget: this.budget, observedTokens, observedUsd, costIncomplete });
    if (outcome.kind === 'ok') {
      this.unmeasurableSince = null;
      return;
    }
    if (outcome.kind === 'unmeasurable') {
      if (this.unmeasurableSince == null) this.unmeasurableSince = Date.now();
      if (Date.now() - this.unmeasurableSince < this.deps.spendGraceMs) return;
      const reason = formatUnmeasurableReason(outcome.dimension);
      const limitValue =
        outcome.dimension === 'tokens' ? (this.budget.tokens ?? 0) : toMicroUsd(this.budget.costUsd ?? 0);
      await this.tripSpend(
        now,
        {
          dimension: outcome.dimension,
          limitValue,
          observedValue: 0,
          configSource: this.budgetConfigSource,
          payload: { unmeasurable: true, graceMs: this.deps.spendGraceMs },
        },
        reason,
      );
      return;
    }
    this.unmeasurableSince = null;
    const trip = outcome.trip;
    const event: GuardrailEventInput =
      trip.dimension === 'tokens'
        ? {
            dimension: 'tokens',
            limitValue: trip.limitTokens,
            observedValue: trip.observedTokens,
            configSource: this.budgetConfigSource,
            payload: {},
          }
        : {
            dimension: 'cost',
            limitValue: toMicroUsd(trip.limitUsd),
            observedValue: toMicroUsd(trip.observedUsd),
            configSource: this.budgetConfigSource,
            payload: { limitUsd: trip.limitUsd, observedUsd: trip.observedUsd },
          };
    await this.tripSpend(now, event, formatBudgetReason(trip));
  }

  /** One tool-timeout watchdog fire: trip on the oldest outstanding tool call
   * that has been open past the bound, but only while a counted Step is running. */
  async evaluateToolTimeout(): Promise<void> {
    if (!this.toolTimeoutMs) return;
    if (this.turn.isSettled()) return;
    const now = await this.deps.attempts.get(this.turn.attemptId);
    if (now.state !== 'running') return;
    if (!countsTowardExecutionBudget(await this.deps.attempts.currentStepType(this.turn.taskId, this.turn.attemptNumber))) return;
    let oldest: { id: string; startedAt: number; title: string | null } | null = null;
    for (const [id, t] of this.outstandingTools) {
      if (!oldest || t.startedAt < oldest.startedAt) oldest = { id, startedAt: t.startedAt, title: t.title };
    }
    if (!oldest) return;
    const trip = toolTimeoutTrip({
      outstandingMs: Date.now() - oldest.startedAt,
      limitMs: this.toolTimeoutMs,
      toolCallId: oldest.id,
      title: oldest.title,
    });
    if (!trip) return;
    await this.tripProgress(
      now,
      {
        dimension: 'tool-timeout',
        limitValue: trip.limitMs,
        observedValue: trip.observedMs,
        payload: { toolCallId: trip.toolCallId, title: trip.title },
      },
      formatToolTimeoutReason(trip),
    );
    this.turn.abort();
    this.turn.kill();
  }

  /**
   * Evaluate the stall detector at a turn boundary (the agent is parked — never
   * concurrent with an in-flight turn). First stall → one nudge via the steer
   * channel (does not spend the continue budget); a stall that survives the
   * nudge turn → trip → Escalate. Returns true when it tripped so the caller
   * breaks the drive loop to settle.
   */
  async checkProgressAtBoundary(): Promise<boolean> {
    if (!this.progressEnabled || this.turn.isSettled() || this.turn.isFinishing()) return false;
    const outstanding = this.turn.outstandingAction();
    const progressTrace =
      outstanding && !this.turn.progressTrace.some((event) => event.seq === outstanding.seq)
        ? [outstanding, ...this.turn.progressTrace]
        : this.turn.progressTrace;
    const report = detectStall(progressTrace, { enabled: true });
    if (!report) return false;
    if (!this.progressNudged) {
      this.progressNudged = true;
      this.turn.record({ event: 'progress-nudge', pattern: report.pattern });
      this.turn.pushSteer(PROGRESS_NUDGE_TEXT);
      return false;
    }
    if (this.turn.hasPendingSteer()) return false;
    const now = await this.deps.attempts.get(this.turn.attemptId);
    if (now.state !== 'running') return false;
    await this.tripProgress(
      now,
      {
        dimension: 'progress',
        limitValue: 0,
        observedValue: report.count,
        payload: { pattern: report.pattern, signatures: report.signatures, seqs: report.seqs },
      },
      formatProgressReason(report),
    );
    return true;
  }

  private async tripSpend(now: AttemptRow, event: GuardrailEventInput, reason: string): Promise<void> {
    await this.appendAndSettle(now, event, reason);
    this.turn.abort();
    this.turn.kill();
    if (this.spendTimer) {
      clearInterval(this.spendTimer);
      this.spendTimer = null;
    }
  }

  private async tripProgress(
    now: AttemptRow,
    evidence: { dimension: 'progress' | 'tool-timeout'; limitValue: number; observedValue: number; payload: unknown },
    reason: string,
  ): Promise<void> {
    await this.appendAndSettle(
      now,
      {
        dimension: evidence.dimension,
        limitValue: evidence.limitValue,
        observedValue: evidence.observedValue,
        configSource: this.progressConfigSource,
        payload: evidence.payload,
      },
      reason,
    );
  }

  private async appendAndSettle(now: AttemptRow, event: GuardrailEventInput, reason: string): Promise<void> {
    const tripAttempt = await this.turn.attemptForTrip();
    await this.deps.guardrailEvents.append(tripAttempt.id, event);
    this.turn.record({ event: 'guardrail-tripped', dimension: event.dimension, reason });
    await this.turn.settle(now, reason);
  }
}
