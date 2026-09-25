import type { SpanContext } from '@opentelemetry/api';
import type { AppConfig } from '../config.js';
import type { TaskRow, AttemptRow } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';
import { resolvePauseMessage } from '../domain/setting-override.js';
import type { ResolvedGuardrails } from '../domain/setting-override.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { ActiveRuns } from './active-runs.js';
import type { SessionContinuation } from './session-continuation.js';
import { logger } from '../logger.js';
import type { RunnerEvents, RunnerOptions } from './runner-options.js';

/** The result of a per-turn boundary check a drive loop runs before spawning its
 * next turn. `settled` covers every externally-settled Task (operator cancel,
 * force-complete, or a race that already paused it another way) — the caller
 * that settled it already did every write this loop needs to respect. */
export type RunBoundaryResult =
  | { stop: false }
  | { stop: true; reason: 'settled' }
  | { stop: true; reason: 'global-pause' }
  | { stop: true; reason: 'operator-pause'; pauseReason: string };

export interface RunControlDeps {
  taskService: TaskService;
  attempts: AttemptStore;
  activeRuns: ActiveRuns;
  events: RunnerEvents;
  getWorkspace: RunnerOptions['getWorkspace'];
  getConfig: () => AppConfig;
  isGloballyPaused: (() => boolean) | undefined;
  onGloballyPaused: ((taskId: number) => Promise<void>) | undefined;
  sessionContinuation: SessionContinuation;
  emitSteerLog: (args: { attemptId: number; text: string; queued: boolean }) => void;
  recordLifecycleTransition: (taskId: number, event: 'paused' | 'resumed', reason: string) => Promise<void>;
  start: (taskId: number) => Promise<AttemptRow>;
  launchClaimed: (taskId: number) => Promise<AttemptRow>;
  beginRun: (task: TaskRow, parent?: SpanContext, resumedAttempt?: AttemptRow) => Promise<AttemptRow>;
}

export class RunControl {
  constructor(private readonly deps: RunControlDeps) {}

  /**
   * Steer a task's active Attempt. When a turn is in flight and the harness
   * supports ACP `_session/steering`, the message is injected into the RUNNING
   * turn; otherwise it is queued and delivered as a fresh prompt turn at the
   * next turn boundary. Records a `steer_injected` or `steer_queued` lifecycle
   * event either way. Returns false (⇒ 409) when the task isn't running here or
   * its Attempt is no longer steerable.
   */
  async steer(taskId: number, text: string): Promise<boolean> {
    const active = this.deps.activeRuns.forTask(taskId);
    if (!active || !active.steerable) return false;
    // ACP `promptRequired`: an idle session must not start an untracked turn.
    if (!active.idle && active.steerSupported !== false) {
      try {
        const res = await active.driver.steer([{ type: 'text', text }], { steering: { idleBehavior: 'promptRequired' } });
        if (res.outcome === 'injected') {
          active.steerSupported = true;
          const event = await this.deps.attempts.appendEvent(active.attemptId, { type: 'lifecycle', payload: { event: 'steer_injected', text } });
          this.deps.events.onAttemptEvent?.(event);
          this.deps.emitSteerLog({ attemptId: active.attemptId, text, queued: false });
          return true;
        }
        // Outcome 'promptRequired': the turn ended before the RPC; nothing ran.
        active.steerSupported = true;
      } catch {
        // No `_session/steering` on this harness (codex/copilot, older claude-acp).
        active.steerSupported = false;
      }
    }
    if (!active.steerable) return false;
    active.steerQueue.push(text);
    const event = await this.deps.attempts.appendEvent(active.attemptId, { type: 'lifecycle', payload: { event: 'steer_queued', text } });
    this.deps.events.onAttemptEvent?.(event);
    this.deps.emitSteerLog({ attemptId: active.attemptId, text, queued: true });
    return true;
  }

  /** A Task with no ActiveRun and no drive loop in flight: nothing will ever honour a
   * boundary marker for it, so pause it in the DB right now — the same fact a
   * stranded Task's Resume already expects to find. */
  private async pauseStrandedNow(taskId: number, reason: string): Promise<boolean> {
    await this.deps.taskService.pause(taskId);
    await this.deps.recordLifecycleTransition(taskId, 'paused', reason);
    logger.info('Task paused', { taskId, reason });
    return true;
  }

  /**
   * Pause a working Task (ADR-0027: graceful, freezes at the next boundary; ADR-0005
   * §6: delivered or refused, never accepted and lost). Handles every shape a
   * working Task can be in:
   *  - a live, steerable turn: deliver the configured pause steer and freeze once it arrives;
   *  - an ActiveRun mid-verify/merge (not steerable): mark intent and a pending
   *    per-Task boundary marker so the next `driveOnce` honours it — a settle that
   *    reaches `done`/`escalated` first wins outright, since this never writes Task
   *    state itself (see {@link checkRunBoundary});
   *  - driving between turns with no ActiveRun: same pending-boundary marker;
   *  - stranded (no ActiveRun, no drive loop in flight): pause immediately.
   */
  async pause(taskId: number): Promise<boolean> {
    const task = await this.deps.taskService.get(taskId);
    if (task.state !== 'working') return false;
    const active = this.deps.activeRuns.forTask(taskId);
    if (!active) {
      if (this.deps.activeRuns.isDriving(taskId)) {
        if (this.deps.activeRuns.hasPendingPause(taskId)) return false;
        this.deps.activeRuns.setPendingPause(taskId, 'operator request');
        logger.info('Task pause requested (between turns)', { taskId });
        return true;
      }
      // Stranded means a running Attempt row survives with nothing driving it; a
      // working Task with no Attempt at all (never spawned) has nothing to freeze.
      if (!(await this.deps.attempts.getRunningForTask(taskId))) return false;
      return this.pauseStrandedNow(taskId, 'operator request');
    }
    if (active.pauseRequested) return false;
    if (!active.steerable) {
      active.pauseRequested = true;
      active.pauseReason = 'operator request';
      this.deps.activeRuns.setPendingPause(taskId, 'operator request');
      logger.info('Task pause requested (settling)', { taskId, attemptId: active.attemptId });
      return true;
    }
    const message = resolvePauseMessage(await this.deps.getWorkspace?.(task.workspaceId), this.deps.getConfig());
    if (!(await this.steer(taskId, message))) return false;
    active.pauseRequested = true;
    active.pauseReason = 'operator request';
    logger.info('Task pause requested', { taskId, attemptId: active.attemptId, reason: active.pauseReason });
    return true;
  }

  async pauseForGlobal(taskId: number): Promise<boolean> {
    const task = await this.deps.taskService.get(taskId);
    if (task.state !== 'working') return false;
    const active = this.deps.activeRuns.forTask(taskId);
    if (!active) return this.pauseStrandedNow(taskId, 'global pause');
    if (!active.steerable) {
      active.pauseRequested = true;
      active.pauseReason = 'global pause';
      active.globalPauseRequested = true;
      // No DB write here: the global flag itself is the persistent boundary
      // trigger (checkRunBoundary rechecks it on every turn), so a settle that
      // reaches done/escalated before the next boundary wins outright instead of
      // stranding the Task paused underneath an already-terminal Attempt.
      logger.info('Task pause requested (settling)', { taskId, attemptId: active.attemptId, reason: 'global pause' });
      return true;
    }
    const paused = await this.pause(taskId);
    if (paused) {
      active.pauseReason = 'global pause';
      active.globalPauseRequested = true;
    }
    return paused;
  }

  /** Resume the still-running Attempt, restarting its wall-clock guardrail from
   * zero before reattaching its durable Session. */
  async resume(taskId: number, reason = 'operator request'): Promise<boolean> {
    const task = await this.deps.taskService.get(taskId);
    if (task.state !== 'paused') return false;
    const startedAt = Date.now();
    const active = this.deps.activeRuns.forTask(taskId);
    if (active) {
      active.pauseRequested = false;
      active.pauseReason = null;
      active.globalPauseRequested = false;
      await this.deps.attempts.update(active.attemptId, { startedAt });
      active.guardrails?.resetWallClock(startedAt);
      await this.deps.taskService.resume(taskId);
      await this.deps.recordLifecycleTransition(taskId, 'resumed', reason);
      logger.info('Task resumed', { taskId, attemptId: active.attemptId, reason });
      return true;
    }
    // Mid-drive between turns isn't stranded; its own loop picks the paused state up.
    if (this.deps.activeRuns.isDriving(taskId)) return false;
    // Claimed synchronously, before the first await, so a second concurrent
    // caller sees isDriving() true rather than racing this one to launch.
    this.deps.activeRuns.markDriving(taskId);
    let launched = false;
    try {
      const run = await this.deps.attempts.getRunningForTask(taskId);
      if (!run) return false;
      await this.deps.attempts.update(run.id, { startedAt });
      const src = await this.deps.sessionContinuation.resolveContinuationSource(task);
      const eligible = src ? this.deps.sessionContinuation.resumeEligibilityFor(task, src.session).eligible : false;
      if (src && !eligible) await this.deps.taskService.setContinuationChoice(taskId, 'condensed');
      await this.deps.taskService.resume(taskId);
      await this.deps.recordLifecycleTransition(taskId, 'resumed', reason);
      logger.info('Task resumed', { taskId, attemptId: run.id, reason });
      try {
        this.deps.activeRuns.setPendingManualResume(taskId, run);
        await this.deps.launchClaimed(taskId);
        launched = true;
        return true;
      } catch (error) {
        await this.deps.taskService.pause(taskId);
        throw error;
      }
    } finally {
      // beginRun owns clearing the marker from here once it has launched;
      // any other exit (early return, thrown error) must release it itself.
      if (!launched) this.deps.activeRuns.clearDriving(taskId);
    }
  }

  /** Reads the running Attempt from the DB: between turns a working Task has no ActiveRun. */
  async extendGuardrail(taskId: number, addMinutes: number): Promise<boolean> {
    const task = await this.deps.taskService.get(taskId);
    if (task.state !== 'working') return false;
    const run = await this.deps.attempts.getRunningForTask(taskId);
    if (!run) return false;
    const config = run.guardrailConfig ? (JSON.parse(run.guardrailConfig) as ResolvedGuardrails) : null;
    if (!config?.budget) return false;
    const wallClockMinutes = config.budget.wallClockMinutes + addMinutes;
    const updated: ResolvedGuardrails = { ...config, budget: { ...config.budget, wallClockMinutes } };
    await this.deps.attempts.update(run.id, { guardrailConfig: JSON.stringify(updated) });
    const active = this.deps.activeRuns.forTask(taskId);
    if (active && active.attemptId === run.id) {
      active.guardrails?.extendWallClock(addMinutes);
    }
    const event = await this.deps.attempts.appendEvent(run.id, {
      type: 'lifecycle',
      payload: { event: 'guardrail_extended', dimension: 'wall-clock', addMinutes, wallClockMinutes },
    });
    this.deps.events.onAttemptEvent?.(event);
    logger.info('Wall-clock guardrail extended', { taskId, attemptId: run.id, addMinutes, wallClockMinutes });
    return true;
  }

  /**
   * The check a drive loop runs before spawning its next turn (the initial one
   * and every self-heal retry): honours a global pause, a per-Task pending pause
   * (issue: operator-control gaps outside a live turn), or notices the Task was
   * already settled externally (operator cancel/force-complete) so the loop must
   * not spawn another turn for it.
   */
  async checkRunBoundary(taskId: number): Promise<RunBoundaryResult> {
    const task = await this.deps.taskService.get(taskId);
    if (task.state !== 'working') return { stop: true, reason: 'settled' };
    if (this.deps.isGloballyPaused?.()) {
      await this.deps.taskService.pause(taskId);
      await this.deps.onGloballyPaused?.(taskId);
      return { stop: true, reason: 'global-pause' };
    }
    const pauseReason = this.deps.activeRuns.takePendingPause(taskId);
    if (pauseReason !== undefined) {
      await this.deps.taskService.pause(taskId);
      await this.deps.recordLifecycleTransition(taskId, 'paused', pauseReason);
      return { stop: true, reason: 'operator-pause', pauseReason };
    }
    return { stop: false };
  }

  /** A resume is never refused; an incompatible or missing Session falls back to start-condensed. */
  async steerSettled(taskId: number, text: string): Promise<boolean> {
    if (this.deps.activeRuns.hasTask(taskId)) return false;
    const task = await this.deps.taskService.get(taskId);
    if (task.state !== 'escalated') return false;
    const src = await this.deps.sessionContinuation.resolveContinuationSource(task);
    const eligible = src ? this.deps.sessionContinuation.resumeEligibilityFor(task, src.session).eligible : false;
    this.deps.activeRuns.setPendingOperatorSeed(taskId, text);
    try {
      await this.deps.taskService.requeue(taskId, undefined, src ? (eligible ? 'full' : 'condensed') : undefined);
      if (src) this.deps.activeRuns.setPendingManualResume(taskId, src.prior);
      await this.deps.start(taskId);
    } catch (err) {
      this.deps.activeRuns.removePendingOperatorSeed(taskId, text);
      throw err;
    }
    return true;
  }

  /** Resumes a paused Task to `working` and delivers the operator message; never refuses. */
  async steerPaused(taskId: number, text: string): Promise<boolean> {
    const task = await this.deps.taskService.get(taskId);
    if (task.state !== 'paused') return false;
    if (this.deps.activeRuns.hasTask(taskId)) {
      return (await this.resume(taskId)) && (await this.steer(taskId, text));
    }
    this.deps.activeRuns.setPendingOperatorSeed(taskId, text);
    try {
      await this.resumePaused(taskId);
    } catch (err) {
      this.deps.activeRuns.removePendingOperatorSeed(taskId, text);
      throw err;
    }
    return true;
  }

  /** Mid-drive between turns just seeds the next turn; genuinely stranded relaunches the same Attempt. */
  async steerWorking(taskId: number, text: string): Promise<boolean> {
    if (this.deps.activeRuns.hasTask(taskId)) return false;
    const task = await this.deps.taskService.get(taskId);
    if (task.state !== 'working') return false;
    const run = await this.deps.attempts.getRunningForTask(taskId);
    if (!run) return false;
    if (this.deps.activeRuns.isDriving(taskId)) {
      this.deps.activeRuns.setPendingOperatorSeed(taskId, text);
      const event = await this.deps.attempts.appendEvent(run.id, { type: 'lifecycle', payload: { event: 'steer_queued', text } });
      this.deps.events.onAttemptEvent?.(event);
      this.deps.emitSteerLog({ attemptId: run.id, text, queued: true });
      return true;
    }
    // Claimed synchronously, before the first await, so a second concurrent
    // caller sees isDriving() true rather than racing this one to launch.
    this.deps.activeRuns.markDriving(taskId);
    let launched = false;
    try {
      const src = await this.deps.sessionContinuation.resolveContinuationSource(task);
      const eligible = src ? this.deps.sessionContinuation.resumeEligibilityFor(task, src.session).eligible : false;
      if (src && !eligible) await this.deps.taskService.setContinuationChoice(taskId, 'condensed');
      this.deps.activeRuns.setPendingOperatorSeed(taskId, text);
      try {
        this.deps.activeRuns.setPendingManualResume(taskId, run);
        await this.deps.launchClaimed(taskId);
        launched = true;
      } catch (err) {
        this.deps.activeRuns.removePendingOperatorSeed(taskId, text);
        throw err;
      }
    } finally {
      if (!launched) this.deps.activeRuns.clearDriving(taskId);
    }
    return true;
  }

  /** Continues a paused Task's retained Attempt; falls back to start-condensed/fresh rather than refusing. */
  async resumePaused(taskId: number, continuation?: 'full' | 'condensed'): Promise<TaskRow> {
    const task = await this.deps.taskService.get(taskId);
    if (task.state !== 'paused') return this.deps.taskService.resume(taskId);
    if (this.deps.activeRuns.hasTask(taskId) || this.deps.activeRuns.isDriving(taskId)) return this.deps.taskService.resume(taskId);
    // Claimed synchronously, before the first await, so a second concurrent
    // caller sees isDriving() true rather than racing this one to launch.
    this.deps.activeRuns.markDriving(taskId);
    let launched = false;
    try {
      const src = await this.deps.sessionContinuation.resolveContinuationSource(task);
      const eligible = src ? this.deps.sessionContinuation.resumeEligibilityFor(task, src.session).eligible : false;
      const effectiveContinuation = continuation ?? (src && !eligible ? 'condensed' : undefined);
      if (effectiveContinuation) await this.deps.taskService.setContinuationChoice(taskId, effectiveContinuation);
      // Reuse the same Attempt: prefer the Task's still-running row (the one
      // actually paused), else fall back to the retained Session's Attempt
      // (no running row survived, e.g. after a restart).
      const resumedAttempt = (await this.deps.attempts.getRunningForTask(taskId)) ?? src?.prior;
      const resumed = await this.deps.taskService.resume(taskId);
      try {
        await this.deps.beginRun(resumed, undefined, resumedAttempt);
        launched = true;
      } catch (err) {
        await this.deps.taskService.setState(taskId, 'paused');
        throw err;
      }
      return this.deps.taskService.get(taskId);
    } finally {
      if (!launched) this.deps.activeRuns.clearDriving(taskId);
    }
  }
}
