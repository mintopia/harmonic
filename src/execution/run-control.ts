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

  /** Deliver the configured pause steer, then pause at the next prompt boundary. */
  async pause(taskId: number): Promise<boolean> {
    const task = await this.deps.taskService.get(taskId);
    if (task.state !== 'working') return false;
    const active = this.deps.activeRuns.forTask(taskId);
    if (!active || active.pauseRequested) return false;
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
    if (!active) {
      await this.deps.taskService.pause(taskId);
      await this.deps.recordLifecycleTransition(taskId, 'paused', 'global pause');
      logger.info('Task paused', { taskId, reason: 'global pause' });
      return true;
    }
    if (!active.steerable) {
      active.pauseRequested = true;
      active.pauseReason = 'global pause';
      active.globalPauseRequested = true;
      await this.deps.taskService.pause(taskId);
      await this.deps.recordLifecycleTransition(taskId, 'paused', 'global pause');
      active.pauseFactRecorded = true;
      logger.info('Task paused', { taskId, attemptId: active.attemptId, reason: active.pauseReason });
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
    const run = await this.deps.attempts.getRunningForTask(taskId);
    if (!run) return false;
    await this.deps.attempts.update(run.id, { startedAt });
    await this.deps.taskService.resume(taskId);
    await this.deps.recordLifecycleTransition(taskId, 'resumed', reason);
    logger.info('Task resumed', { taskId, attemptId: run.id, reason });
    try {
      await this.deps.launchClaimed(taskId);
      return true;
    } catch (error) {
      await this.deps.taskService.pause(taskId);
      throw error;
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

  async pauseIfGloballyPaused(taskId: number): Promise<boolean> {
    if (!this.deps.isGloballyPaused?.()) return false;
    if ((await this.deps.taskService.get(taskId)).state === 'working') {
      await this.deps.taskService.pause(taskId);
      await this.deps.onGloballyPaused?.(taskId);
    }
    return true;
  }

  /**
   * Continue a settled Task's Session with an operator message. A cold Session
   * remains eligible: cache warmth changes the cost estimate, never whether the
   * operator can continue it. Incompatible for continue-full (harness/adapter
   * version/cwd/permission-mode changed) falls back to start-condensed rather
   * than refusing — a resume is never refused, only its Cost estimate changes
   * (ADR-0027). The settled Attempt is resumed in place. Returns false only
   * when the Task isn't escalated or never recorded a Session to continue at
   * all — there is nothing to condense from.
   */
  async steerSettled(taskId: number, text: string): Promise<boolean> {
    if (this.deps.activeRuns.hasTask(taskId)) return false;
    const task = await this.deps.taskService.get(taskId);
    if (task.state !== 'escalated') return false;
    const src = await this.deps.sessionContinuation.resolveContinuationSource(task);
    if (!src) return false;
    const eligible = this.deps.sessionContinuation.resumeEligibilityFor(task, src.session).eligible;
    this.deps.activeRuns.setPendingOperatorSeed(taskId, text);
    try {
      await this.deps.taskService.requeue(taskId, undefined, eligible ? 'full' : 'condensed');
      this.deps.activeRuns.setPendingManualResume(taskId, src.prior);
      await this.deps.start(taskId);
    } catch (err) {
      this.deps.activeRuns.clearPendingOperatorSeed(taskId);
      throw err;
    }
    return true;
  }

  /**
   * Steer a paused Task: resume it to `working` and deliver the operator message.
   * A live paused Attempt is reattached (its wall-clock guardrail restarts) and
   * the message is steered into it; a torn-down one is continued via
   * {@link resumePaused}, which never refuses — an incompatible or missing
   * Session falls back to start-condensed/fresh rather than stranding the Task.
   * Returns false only when the Task isn't paused.
   */
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
      this.deps.activeRuns.clearPendingOperatorSeed(taskId);
      throw err;
    }
    return true;
  }

  /**
   * Steer a `working` Task with no live ActiveRun: a running Attempt row
   * survived (process restart, upgrade, or torn down between turns) but
   * nothing is executing it — the Task is stranded. Relaunches the *same*
   * Attempt (the counter only advances on a failed verdict, ADR-0027):
   * continue-full when its retained Session is still compatible, else
   * start-condensed, seeded with the operator message. Returns false when the
   * Task isn't `working`, already has a live ActiveRun (steer() covers that),
   * or genuinely has no running Attempt row to relaunch.
   */
  async steerWorking(taskId: number, text: string): Promise<boolean> {
    if (this.deps.activeRuns.hasTask(taskId)) return false;
    const task = await this.deps.taskService.get(taskId);
    if (task.state !== 'working') return false;
    const run = await this.deps.attempts.getRunningForTask(taskId);
    if (!run) return false;
    const src = await this.deps.sessionContinuation.resolveContinuationSource(task);
    const eligible = src ? this.deps.sessionContinuation.resumeEligibilityFor(task, src.session).eligible : false;
    if (src && !eligible) await this.deps.taskService.setContinuationChoice(taskId, 'condensed');
    this.deps.activeRuns.setPendingOperatorSeed(taskId, text);
    try {
      this.deps.activeRuns.setPendingManualResume(taskId, run);
      await this.deps.launchClaimed(taskId);
    } catch (err) {
      this.deps.activeRuns.clearPendingOperatorSeed(taskId);
      throw err;
    }
    return true;
  }

  /**
   * Resume a paused Task, continuing its retained Attempt. `continuation` is
   * the operator's explicit pick: `condensed` starts a fresh Session from a
   * summary, `full`/undefined reuses the retained one when it is still
   * compatible. A Session that is still live is always continued — a running
   * process can't be forked into a fresh attempt. Incompatible-for-continue-full
   * (harness/adapter-version/cwd/permission-mode changed) and no retained
   * Session at all both fall back to start-condensed/fresh: a resume is never
   * refused (ADR-0027), so this never leaves the Task `working` with nothing
   * running.
   */
  async resumePaused(taskId: number, continuation?: 'full' | 'condensed'): Promise<TaskRow> {
    const task = await this.deps.taskService.get(taskId);
    if (task.state !== 'paused') return this.deps.taskService.resume(taskId);
    if (this.deps.activeRuns.hasTask(taskId)) return this.deps.taskService.resume(taskId);
    const src = await this.deps.sessionContinuation.resolveContinuationSource(task);
    const eligible = src ? this.deps.sessionContinuation.resumeEligibilityFor(task, src.session).eligible : false;
    const effectiveContinuation = continuation ?? (src && !eligible ? 'condensed' : undefined);
    if (effectiveContinuation) await this.deps.taskService.setContinuationChoice(taskId, effectiveContinuation);
    // Reuse the same Attempt: prefer the one the retained Session hangs off,
    // else fall back to the Task's still-running row (no Session ever bound).
    const resumedAttempt = src?.prior ?? (await this.deps.attempts.getRunningForTask(taskId));
    const resumed = await this.deps.taskService.resume(taskId);
    try {
      await this.deps.beginRun(resumed, undefined, resumedAttempt);
    } catch (err) {
      await this.deps.taskService.setState(taskId, 'paused');
      throw err;
    }
    return this.deps.taskService.get(taskId);
  }
}
