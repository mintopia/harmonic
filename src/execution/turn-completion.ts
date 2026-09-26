import { Git } from './git.js';
import { attempted } from '../error-handling.js';
import { runMergePolicy } from './merge-policy.js';
import { observedModelMismatch, type AttemptUsage } from './usage.js';
import { AcpDriver, AcpPromptTimeoutError, type PromptResult } from '../acp/driver.js';
import { AcpConnectionClosedError } from '../acp/connection.js';
import type { ActiveRun, ActiveRuns } from './active-runs.js';
import type { GuardrailSupervisor } from './guardrail-supervisor.js';
import type { TurnListeners } from './turn-listeners.js';
import type { TaskRow, AttemptRow } from '../db/schema.js';
import type { AppConfig, HarnessConfig } from '../config.js';
import type { SpanContext } from '@opentelemetry/api';
import type { RunnerOptions, Workspace } from './runner.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { UsageSampler } from './usage-sampler.js';
import type { VerificationCoordinator } from './verification-coordinator.js';
import type { MergeCoordinator } from './merge-coordinator.js';
import type { TaskService } from '../domain/tasks.js';
import type { AutoDrive } from './auto-drive.js';

export type TurnOutcome =
  | { kind: 'terminal' }
  | { kind: 'actionable-fail'; reason: string; output: string };

export type RunEventRecorder = (type: 'permission_request' | 'lifecycle', payload: unknown) => void;

export interface TurnCompletionDeps {
  attempts: AttemptStore;
  usage: UsageSampler;
  activeRuns: ActiveRuns;
  mergeCoordinator: MergeCoordinator;
  verification: VerificationCoordinator;
  autoDrive: AutoDrive | undefined;
  taskService: TaskService;
  getConfig: () => AppConfig;
  postMerge: RunnerOptions['postMerge'];
  isShuttingDown: () => boolean;
  settleEscalated: (task: TaskRow, run: AttemptRow, reason: string, patch: Partial<AttemptRow>) => Promise<void>;
  settleAutoCompleted: (task: TaskRow, run: AttemptRow, patch: Partial<AttemptRow>) => Promise<void>;
  diffSnapshotFor: (
    task: TaskRow, attemptId: number,
  ) => Promise<Pick<AttemptRow, 'stat' | 'diffBaseOid' | 'diffHeadOid'>>;
  worktreePathForTask: (task: TaskRow) => string;
  updateStep: (
    taskId: number, id: number, patch: Parameters<AttemptStore['updateStep']>[1],
  ) => Promise<Awaited<ReturnType<AttemptStore['updateStep']>>>;
}

export class TurnCompletion {
  constructor(private readonly deps: TurnCompletionDeps) {}

  async drivePromptCycle(input: {
    task: TaskRow;
    driver: AcpDriver;
    active: ActiveRun;
    guardrails: GuardrailSupervisor;
    listeners: TurnListeners;
    autoDriven: boolean;
    promptText: string;
    /** An operator steer accepted before this turn existed, folded into `promptText`. */
    operatorSeed?: string | undefined;
    record: RunEventRecorder;
  }): Promise<{ result: PromptResult; connectionGone: boolean; escalating: string | null; operatorSeedDelivered: boolean }> {
    const { task, driver, active, guardrails, listeners, autoDriven, record } = input;
    let promptText = input.promptText;
    let escalating: string | null = null;
    // A pause requested before this turn's first prompt: bail before promptText — including
    // input.operatorSeed — ever reaches the harness. The caller must put the seed back rather
    // than treat it as delivered (ADR-0005 §6).
    if (active.pauseRequested) return { result: {}, connectionGone: false, escalating: null, operatorSeedDelivered: false };
    active.steerable = true;
    let connectionGone = false;
    if (input.operatorSeed !== undefined) record('lifecycle', { event: 'steer_delivered', text: input.operatorSeed });
    const first = await promptTurn(driver, promptText, record);
    connectionGone ||= first.connectionGone;
    let result: PromptResult = first.result ?? {};
    active.idle = true;
    for (let attempt = 1; !escalating && !listeners.stoppedShort && !connectionGone; ) {
      if (active.externallySettled) break;
      if (active.pauseRequested && active.steerQueue.length === 0) break;
      if (active.escalateReason) {
        escalating = `the agent asked for a human: ${active.escalateReason}`;
        break;
      }
      if (await guardrails.checkProgressAtBoundary()) break;
      const steer = active.steerQueue.shift();
      if (steer !== undefined) {
        record('lifecycle', { event: 'steer_delivered', text: steer });
        active.idle = false;
        const turn = await promptTurn(driver, steer, record);
        connectionGone ||= turn.connectionGone;
        if (turn.result) result = turn.result;
        active.idle = true;
        if (connectionGone) break;
        continue;
      }
      if (!autoDriven || active.agentFinished || attempt > (await this.deps.autoDrive!.continueAttempts(task))) {
        break;
      }
      record('lifecycle', { event: 'continue', attempt });
      promptText = await this.deps.autoDrive!.continuePrompt(task);
      active.idle = false;
      const turn = await promptTurn(driver, promptText, record);
      connectionGone ||= turn.connectionGone;
      if (turn.result) result = turn.result;
      active.idle = true;
      if (connectionGone) break;
      attempt++;
    }
    active.idle = false;
    active.steerable = false;
    while (!connectionGone && !active.externallySettled && !escalating && !listeners.stoppedShort && active.steerQueue.length > 0) {
      const steer = active.steerQueue.shift()!;
      record('lifecycle', { event: 'steer_delivered', text: steer });
      const turn = await promptTurn(driver, steer, record);
      connectionGone ||= turn.connectionGone;
      if (turn.result) result = turn.result;
    }
    return { result, connectionGone, escalating, operatorSeedDelivered: input.operatorSeed !== undefined };
  }

  async finishDrivenTurn(input: {
    task: TaskRow;
    run: AttemptRow;
    harness: HarnessConfig;
    parent: SpanContext;
    workspace: Workspace;
    active: ActiveRun;
    listeners: TurnListeners;
    autoDriven: boolean;
    attemptNumber: number;
    driven: { result: PromptResult; connectionGone: boolean; escalating: string | null };
    record: RunEventRecorder;
    finalize: () => Promise<void>;
    advanceTask: (to: 'verifying' | 'merging') => Promise<void>;
  }): Promise<TurnOutcome> {
    const {
      task,
      run,
      harness,
      parent,
      workspace,
      active,
      listeners,
      autoDriven,
      attemptNumber,
      record,
      finalize,
      advanceTask,
    } = input;
    let { result, connectionGone, escalating } = input.driven;
    record('lifecycle', { event: 'finished', stopReason: result.stopReason ?? null });
    const afkUnresolved = autoDriven && !escalating && !listeners.stoppedShort && !active.agentFinished;
    if (afkUnresolved) record('lifecycle', { event: 'unresolved', reason: 'no finish_task signal; verifying anyway' });
    const resolvedHead = await this.resolveImplementationHead({
      task, run, workspace, active, attemptNumber, escalating, stoppedShort: listeners.stoppedShort, connectionGone, result, record,
    });
    ({ connectionGone, result } = resolvedHead);
    let { implementationHead, noChangeFinishHead } = resolvedHead;
    await finalize();
    const usage = await this.deps.usage.collectUsageSafe({
      harnessId: task.harness,
      harness,
      cwd: workspace.cwd,
      attemptId: run.id,
      promptResult: result,
    });
    if (usage?.contextTokens != null) this.deps.activeRuns.setLastTurnContextTokens(run.id, usage.contextTokens);
    noteModelMismatch(task, usage, record);
    const patch = {
      stopReason: result.stopReason ?? null,
      usage: usage ? JSON.stringify(usage) : null,
    };
    if (escalating) {
      record('lifecycle', { event: 'escalated', reason: escalating });
      await this.deps.settleEscalated(task, run, escalating, patch);
      return { kind: 'terminal' };
    }
    if (listeners.stoppedShort) {
      record('lifecycle', { event: 'stopped-short', reason: listeners.stoppedShort });
      return { kind: 'actionable-fail', reason: listeners.stoppedShort, output: '' };
    }
    await advanceTask('verifying');
    let noChange = false;
    if (noChangeFinishHead) {
      if (!(await this.deps.verification.criticEnabledFor(task))) {
        const reason = 'the agent finished without changing any files and no critic is configured to judge whether that is correct';
        record('lifecycle', { event: 'escalated', reason });
        await this.deps.settleEscalated(task, run, reason, patch);
        return { kind: 'terminal' };
      }
      implementationHead = noChangeFinishHead;
      noChange = true;
    }
    const { decision, ran: verifierRan } = await this.deps.verification.runVerification(
      task,
      run,
      implementationHead,
      active.verifyAbort.signal,
      record,
      parent,
    );
    if (this.deps.isShuttingDown()) return { kind: 'terminal' };
    if (active.externallySettled) {
      await finalize();
      return { kind: 'terminal' };
    }
    if (decision.outcome === 'block') {
      return await this.deps.verification.verificationFailTurn(task, decision, record);
    }
    if (decision.outcome !== 'proceed') {
      if ((await this.deps.attempts.get(run.id)).verifiedHeadOid == null) {
        const reason = `verification ${decision.outcome}: ${decision.reason}`;
        record('lifecycle', { event: 'escalated', reason });
        await this.deps.settleEscalated(task, run, reason, patch);
        return { kind: 'terminal' };
      }
      return await this.deps.verification.verificationFailTurn(task, decision, record);
    }
    if (afkUnresolved && (!verifierRan || (await this.deps.attempts.get(run.id)).verifiedHeadOid == null)) {
      record('lifecycle', { event: 'unresolved', reason: 'no finish_task signal and no verifier vouched for the work' });
      // advanceTask('verifying') optimistically passed the implementation step; this turn never actually resolved.
      await this.failImplementationStep(task.id, run.id);
      return { kind: 'actionable-fail', reason: 'attempt ended without an execution-complete (finish_task) signal', output: '' };
    }
    return this.mergeAndSettle({ task, run, record, signal: active.verifyAbort.signal, patch, autoDriven, noChange, advanceTask });
  }

  /**
   * Operator Accept step-advance (ADR-0038): the caller already overrode the
   * failed Step to `passed`. Runs the remaining pipeline from `startAt` with no
   * implementation turn — a passing outcome merges and settles `done`; a
   * failing one escalates again immediately (the operator's override already
   * spent this Attempt's one chance at this Step).
   */
  async advanceAccepted(input: {
    task: TaskRow;
    run: AttemptRow;
    record: RunEventRecorder;
    parent: SpanContext;
    signal: AbortSignal;
    startAt: 'commands' | 'critics';
  }): Promise<void> {
    const { task, run, record, parent, signal, startAt } = input;
    const { decision } = await this.deps.verification.runVerification(task, run, run.verifiedHeadOid, signal, record, parent, true, startAt);
    if (decision.outcome !== 'proceed') {
      const fail = await this.deps.verification.verificationFailTurn(task, decision, record);
      const feedback = [fail.reason, fail.output].filter(Boolean).join('\n\n');
      await this.deps.settleEscalated(task, run, fail.reason, { feedback });
      return;
    }
    await this.mergeAndSettle({ task, run, record, signal, patch: {}, autoDriven: false, noChange: false, advanceTask: async () => {} });
  }

  private async failImplementationStep(taskId: number, attemptId: number): Promise<void> {
    const rows = await this.deps.attempts.listSteps(attemptId);
    const implementation = [...rows].reverse().find((row) => row.type === 'implementation');
    if (implementation) await this.deps.updateStep(taskId, implementation.id, { state: 'failed', endedAt: Date.now() });
  }

  private async resolveImplementationHead(input: {
    task: TaskRow;
    run: AttemptRow;
    workspace: Workspace;
    active: ActiveRun;
    attemptNumber: number;
    escalating: string | null;
    stoppedShort: string | null;
    connectionGone: boolean;
    result: PromptResult;
    record: RunEventRecorder;
  }): Promise<{ connectionGone: boolean; result: PromptResult; implementationHead: string | null; noChangeFinishHead: string | null }> {
    const { run, workspace, active, escalating, stoppedShort, record } = input;
    let { connectionGone, result } = input;
    let implementationHead: string | null = null;
    let noChangeFinishHead: string | null = null;
    if (escalating || stoppedShort) return { connectionGone, result, implementationHead, noChangeFinishHead };
    if (!connectionGone && !workspace.startDirty && (await Git.isDirty(workspace.cwd).catch(() => false))) {
      const nudge = 'Your implementation left uncommitted changes. Commit the completed work now, then finish.';
      record('lifecycle', { event: 'commit-nudge' });
      active.idle = false;
      const turn = await promptTurn(active.driver, nudge, record);
      connectionGone ||= turn.connectionGone;
      if (turn.result) result = turn.result;
      active.idle = true;
    }
    const dirty = !workspace.startDirty && (await Git.isDirty(workspace.cwd).catch(() => false));
    const [head, base] = await Promise.all([
      Git.revParse(workspace.cwd, 'HEAD').catch(() => null),
      workspace.baseRev ? Git.revParse(workspace.cwd, workspace.baseRev).catch(() => null) : Promise.resolve(null),
    ]);
    if (head && (head !== base || dirty)) {
      implementationHead = head;
      await this.deps.attempts.update(run.id, { verifiedHeadOid: head });
    } else if (run.verifiedHeadOid) {
      implementationHead = run.verifiedHeadOid;
    } else if (active.agentFinished && head) {
      noChangeFinishHead = head;
    }
    return { connectionGone, result, implementationHead, noChangeFinishHead };
  }

  private async mergeAndSettle(input: {
    task: TaskRow;
    run: AttemptRow;
    record: RunEventRecorder;
    signal: AbortSignal;
    patch: Partial<AttemptRow>;
    autoDriven: boolean;
    noChange: boolean;
    advanceTask: (to: 'verifying' | 'merging') => Promise<void>;
  }): Promise<TurnOutcome> {
    const { task, run, record, signal, patch, autoDriven, noChange, advanceTask } = input;
    const worktreeMerge = task.isolationMode === 'worktree';
    if (worktreeMerge) {
      const cwd = this.deps.worktreePathForTask(task);
      if (await Git.isDirty(cwd).catch(() => false)) {
        const committed = await attempted(() => Git.commitAll(cwd, `harmonic: task ${task.id} attempt ${run.number}`), {
          op: 'runner.mergeAndSettle.commitAll',
          level: 'error',
          context: { taskId: task.id, attemptId: run.id, attemptNumber: run.number },
        });
        if (!committed.ok) {
          const reason = `could not commit outstanding work before merge: ${committed.message}`;
          record('lifecycle', { event: 'escalated', reason });
          await this.deps.settleEscalated(task, run, reason, patch);
          return { kind: 'terminal' };
        }
        if (committed.value !== null) {
          record('lifecycle', { event: 'work-committed', oid: committed.value, reason: 'pre-merge' });
          await this.deps.attempts.update(run.id, { verifiedHeadOid: committed.value });
        }
      }
    }
    const diff = await this.deps.diffSnapshotFor(task, run.id);
    const current = await this.deps.attempts.get(run.id);
    const deps = this.deps.mergeCoordinator.mergePolicyDeps(task, run, record, signal, patch);
    const mergeWorktreeBranch = async (): Promise<boolean> => {
      await this.deps.taskService.setMergeStatus(task.id, 'merging');
      const outcome = await runMergePolicy(
        {
          baseDir: task.workingDir,
          baseBranch: current.baseBranch!,
          taskBranch: current.branch!,
          conflictResolveTurns: task.conflictResolveTurns,
          postMergeCheck: this.deps.getConfig().merge.postMergeCheck,
        },
        deps,
      );
      if (outcome.kind === 'escalated') {
        record('lifecycle', { event: 'escalated', reason: outcome.message, gate: outcome.reason });
        if (outcome.reason === 'conflict') await this.deps.taskService.setMergeStatus(task.id, 'resolving-conflicts');
        return false;
      }
      record('lifecycle', { event: 'merged', oid: outcome.mergeOid, baseBranch: current.baseBranch });
      await this.deps.postMerge?.({ repoDir: task.workingDir, baseBranch: current.baseBranch! });
      return true;
    };
    if (!autoDriven) {
      if (!noChange && worktreeMerge && !(await mergeWorktreeBranch())) {
        return { kind: 'terminal' };
      }
      await advanceTask('merging');
      await this.deps.settleAutoCompleted(task, run, { ...patch, ...diff });
      return { kind: 'terminal' };
    }
    const mergeFate = await this.deps.autoDrive!.mergeFateFor(task);
    if (!noChange && worktreeMerge && mergeFate === 'auto-merge' && !(await mergeWorktreeBranch())) {
      return { kind: 'terminal' };
    }
    const outcome = noChange
      ? (await this.deps.autoDrive!.closeCompleted(task))
        ? 'completed'
        : 'escalate'
      : await this.deps.autoDrive!.onCompleted(task, await this.deps.attempts.get(run.id));
    if (outcome === 'escalate') {
      record('lifecycle', { event: 'escalated', reason: 'merge fate could not be applied' });
      await this.deps.settleEscalated(task, run, 'merge fate could not be applied', patch);
    } else {
      await advanceTask('merging');
      await this.deps.settleAutoCompleted(task, run, { ...patch, ...diff });
    }
    return { kind: 'terminal' };
  }
}

export async function promptTurn(
  driver: AcpDriver,
  text: string,
  record: (type: 'permission_request' | 'lifecycle', payload: unknown) => void,
): Promise<{ result: PromptResult | null; connectionGone: boolean }> {
  try {
    return { result: await driver.prompt([{ type: 'text', text }]), connectionGone: false };
  } catch (err) {
    if (err instanceof AcpPromptTimeoutError) {
      record('lifecycle', { event: 'turn-timeout', reason: err.message });
      return { result: null, connectionGone: false };
    }
    if (err instanceof AcpConnectionClosedError) {
      record('lifecycle', { event: 'turn-eof', reason: err.message });
      return { result: null, connectionGone: true };
    }
    throw err;
  }
}

export function noteModelMismatch(
  task: TaskRow,
  usage: AttemptUsage | null,
  record: (type: 'permission_request' | 'lifecycle', payload: unknown) => void,
): void {
  const observed = usage ? observedModelMismatch(task.model, usage.models) : null;
  if (observed) record('lifecycle', { event: 'model_mismatch', expected: task.model, observed });
}
