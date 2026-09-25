import type { ChildProcess } from 'node:child_process';
import type { AcpDriver } from '../acp/driver.js';
import type { HarnessConfig } from '../config.js';
import type { AttemptRow } from '../db/schema.js';
import type { DeterministicContinuation } from '../domain/session-continuation.js';
import type { ProgressEvent } from '../domain/stall-detector.js';
import type { Operation } from '../telemetry/operations.js';
import type { GuardrailSupervisor } from './guardrail-supervisor.js';

export interface ActiveRun {
  attemptId: number;
  taskId: number;
  child: ChildProcess;
  driver: AcpDriver;
  harnessId: string;
  harness: HarnessConfig;
  cwd: string;
  activity: string | null;
  agentFinished: boolean;
  escalateReason: string | null;
  steerQueue: string[];
  idle: boolean;
  externallySettled: boolean;
  steerable: boolean;
  steerSupported?: boolean;
  pauseRequested: boolean;
  pauseReason: string | null;
  pauseFactRecorded: boolean;
  globalPauseRequested: boolean;
  verifyAbort: AbortController;
  /** Assigned once the supervisor is built (see createTurnRuntime), so a resume
   * can restart its wall-clock guardrail from zero. */
  guardrails?: GuardrailSupervisor;
}

export class ActiveRuns {
  private readonly runs = new Map<number, ActiveRun>();
  private readonly driving = new Set<number>();
  private readonly operations = new Map<number, Operation>();
  private readonly toolCallTotals = new Map<number, Map<string, number>>();
  private readonly lastTurnContextTokens = new Map<number, number>();
  private readonly pendingOperatorSeed = new Map<number, string[]>();
  private readonly pendingPause = new Map<number, string>();
  private readonly pendingContinuation = new Map<number, DeterministicContinuation>();
  private readonly pendingManualResume = new Map<number, AttemptRow>();
  private readonly progressTraces = new Map<number, ProgressEvent[]>();
  private readonly progressSequences = new Map<number, number>();
  private readonly criticLogSequences = new Map<number, number>();
  private readonly outstandingProgressActions = new Map<number, ProgressEvent>();

  get(attemptId: number): ActiveRun | undefined {
    return this.runs.get(attemptId);
  }

  set(attemptId: number, run: ActiveRun): void {
    this.runs.set(attemptId, run);
  }

  delete(attemptId: number): void {
    this.runs.delete(attemptId);
  }

  // settleTaskRun awaits mid-loop while driveOnce can concurrently delete, so this must stay the live Map iterator, not a snapshot array.
  values(): IterableIterator<ActiveRun> {
    return this.runs.values();
  }

  get activeCount(): number {
    return this.runs.size;
  }

  forTask(taskId: number): ActiveRun | undefined {
    for (const active of this.runs.values()) {
      if (active.taskId === taskId) return active;
    }
    return undefined;
  }

  hasTask(taskId: number): boolean {
    return this.forTask(taskId) !== undefined;
  }

  /** Marks a Task as having a `beginRun`/`drive()` loop in flight, including
   * the pre-spawn/between-turns gaps where no per-turn {@link ActiveRun}
   * exists. A stranded Task is one with no ActiveRun AND not driving. */
  markDriving(taskId: number): void {
    this.driving.add(taskId);
  }

  clearDriving(taskId: number): void {
    this.driving.delete(taskId);
  }

  isDriving(taskId: number): boolean {
    return this.driving.has(taskId);
  }

  // Clears only the active-run map; the other 10 maps are released per-attempt via releaseAttempt.
  clear(): void {
    this.runs.clear();
  }

  getOperation(attemptId: number): Operation | undefined {
    return this.operations.get(attemptId);
  }

  setOperation(attemptId: number, operation: Operation): void {
    this.operations.set(attemptId, operation);
  }

  deleteOperation(attemptId: number): void {
    this.operations.delete(attemptId);
  }

  nextProgressSequence(attemptId: number): number {
    const seq = (this.progressSequences.get(attemptId) ?? 0) + 1;
    this.progressSequences.set(attemptId, seq);
    return seq;
  }

  nextCriticLogSequence(attemptId: number): number {
    const seq = (this.criticLogSequences.get(attemptId) ?? 0) + 1;
    this.criticLogSequences.set(attemptId, seq);
    return seq;
  }

  getOutstandingProgressAction(attemptId: number): ProgressEvent | undefined {
    return this.outstandingProgressActions.get(attemptId);
  }

  setOutstandingProgressAction(attemptId: number, event: ProgressEvent): void {
    this.outstandingProgressActions.set(attemptId, event);
  }

  clearOutstandingProgressAction(attemptId: number): void {
    this.outstandingProgressActions.delete(attemptId);
  }

  // A list, not a single value: two steers accepted while driving between turns
  // (ADR-0005 §6) must both survive — a second set must never overwrite the first.
  setPendingOperatorSeed(taskId: number, text: string): void {
    const queued = this.pendingOperatorSeed.get(taskId) ?? [];
    queued.push(text);
    this.pendingOperatorSeed.set(taskId, queued);
  }

  /** Every pending message for this Task, joined in acceptance order. */
  takePendingOperatorSeed(taskId: number): string | undefined {
    const queued = this.pendingOperatorSeed.get(taskId);
    if (!queued || queued.length === 0) return undefined;
    this.pendingOperatorSeed.delete(taskId);
    return queued.join('\n\n');
  }

  /** Removes only the one message an error-path caller itself queued, leaving any other operator's pending seed intact. */
  removePendingOperatorSeed(taskId: number, text: string): void {
    const queued = this.pendingOperatorSeed.get(taskId);
    if (!queued) return;
    const idx = queued.indexOf(text);
    if (idx === -1) return;
    queued.splice(idx, 1);
    if (queued.length === 0) this.pendingOperatorSeed.delete(taskId);
  }

  clearPendingOperatorSeed(taskId: number): void {
    this.pendingOperatorSeed.delete(taskId);
  }

  setPendingPause(taskId: number, reason: string): void {
    this.pendingPause.set(taskId, reason);
  }

  hasPendingPause(taskId: number): boolean {
    return this.pendingPause.has(taskId);
  }

  takePendingPause(taskId: number): string | undefined {
    const reason = this.pendingPause.get(taskId);
    this.pendingPause.delete(taskId);
    return reason;
  }

  clearPendingPause(taskId: number): void {
    this.pendingPause.delete(taskId);
  }

  setPendingContinuation(taskId: number, continuation: DeterministicContinuation): void {
    this.pendingContinuation.set(taskId, continuation);
  }

  takePendingContinuation(taskId: number): DeterministicContinuation | undefined {
    const continuation = this.pendingContinuation.get(taskId);
    this.pendingContinuation.delete(taskId);
    return continuation;
  }

  setPendingManualResume(taskId: number, attempt: AttemptRow): void {
    this.pendingManualResume.set(taskId, attempt);
  }

  takePendingManualResume(taskId: number): AttemptRow | undefined {
    const attempt = this.pendingManualResume.get(taskId);
    this.pendingManualResume.delete(taskId);
    return attempt;
  }

  getToolCallTotals(attemptId: number): Map<string, number> | undefined {
    return this.toolCallTotals.get(attemptId);
  }

  setToolCallTotals(attemptId: number, totals: Map<string, number>): void {
    this.toolCallTotals.set(attemptId, totals);
  }

  deleteToolCallTotals(attemptId: number): void {
    this.toolCallTotals.delete(attemptId);
  }

  // Returns the live field itself: UsageSampler holds this by reference and reads it later, so a copy would silently break the tool-call rollup.
  toolCallTotalsView(): ReadonlyMap<number, Map<string, number>> {
    return this.toolCallTotals;
  }

  getProgressTrace(attemptId: number): ProgressEvent[] | undefined {
    return this.progressTraces.get(attemptId);
  }

  setProgressTrace(attemptId: number, events: ProgressEvent[]): void {
    this.progressTraces.set(attemptId, events);
  }

  getLastTurnContextTokens(attemptId: number): number | undefined {
    return this.lastTurnContextTokens.get(attemptId);
  }

  setLastTurnContextTokens(attemptId: number, tokens: number): void {
    this.lastTurnContextTokens.set(attemptId, tokens);
  }

  // Does NOT touch `runs` or `operations` — operations outlives attempt teardown.
  releaseAttempt(attemptId: number): void {
    this.toolCallTotals.delete(attemptId);
    this.lastTurnContextTokens.delete(attemptId);
    this.progressTraces.delete(attemptId);
    this.progressSequences.delete(attemptId);
    this.criticLogSequences.delete(attemptId);
    this.outstandingProgressActions.delete(attemptId);
  }
}
