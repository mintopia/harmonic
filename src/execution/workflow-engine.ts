import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, VerificationCommand } from '../config.js';
import type { AttemptRow, TaskOrigin, TaskRow, WorkflowStepOutcome } from '../db/schema.js';
import type { TrackerRef } from '../tracker/adapter.js';
import type { VarRecord } from '../domain/workflow-vars.js';
import type { WorkflowEntry } from '../domain/workflow-library-store.js';
import { evaluateCondition, findInterpolations, interpolate, type ExpressionContext, type Value } from '../domain/workflow-expression.js';
import { agentStepWith, criticStepWith, parseWorkflow, resolveAttemptsMax, type WorkflowStepDefinition } from '../domain/workflow.js';
import { snapshotVars } from '../domain/workflow-vars.js';
import type { ModelOptionResolution } from '../domain/model-options.js';
import { harnessConfig, resolveRoute, type ResolvedRoute } from '../domain/route.js';
import { stepRunOwnerKey, type StepRunOwner, type WorkflowStepOutputs, type WorkflowStepRunStore } from '../domain/workflow-step-runs.js';
import { maskSecrets } from '../secrets/mask.js';
import { errorMessage } from '../error-handling.js';
import type { CriticDriveRequest, CriticDriveResult } from '../verification/critic.js';
import { exitCodeToVerdict, OUTPUT_CHAR_CAP, type CommandSpawn } from '../verification/command-verifier.js';
import type { MergeIntoBaseOutcome } from './branch-merge.js';
import { Git } from './git.js';
import { LOCAL_TARGET } from './execution-targets.js';
import type { PodOpener } from './pod-opener.js';
import type { PodSession } from './pod-session.js';
import { buildWorkflowCriticPrompt, renderAgentPrompt } from './prompt-assembly.js';
import { appendFeedback, type DriveFields } from './prompt-template.js';
import type { EnginePrompts } from '../domain/bundled-prompts.js';
import { PROMPT_CODE_PATTERN } from '../domain/prompt-library.js';
import { parseCriticOutput } from '../verification/critic-schema.js';

/** What the engine reads of the thing it runs on: a Task row, or an Epic. */
export interface EngineSubject {
  id?: number;
  epicRef?: TrackerRef;
  workflowRef: string | null;
  workflowVars: VarRecord | null;
  prompt: string;
  feedback: string | null;
  trackerTitle: string | null;
  trackerBody: string | null;
  trackerLabels: string[] | null;
  trackerRef: TrackerRef | null;
  origin: TaskOrigin;
  workspaceId: number | null;
  workingDir: string;
}

export interface EpicSubject extends EngineSubject {
  epicRef: TrackerRef;
  workspaceId: number;
}

export function stepRunOwner(subject: EngineSubject): StepRunOwner {
  if (subject.epicRef !== undefined && subject.workspaceId !== null) return { workspaceId: subject.workspaceId, epicRef: subject.epicRef };
  if (subject.id !== undefined) return { taskId: subject.id };
  throw new Error('workflow subject has neither a Task id nor an Epic ref');
}

export const ONLY_THE_AGENT_COMMITS = 'only the agent commits';
export const UNCOMMITTED_AFTER_AGENT = 'uncommitted changes remain after the agent turn';
export const DEFAULT_CONTINUE_PROMPT = 'You have uncommitted changes in the worktree. Commit your work with a clear message, then stop.';
const DEFAULT_AGENT_TIMEOUT_MS = 60 * 60 * 1000;
export const CRITIC_CHANGED_THE_WORK = 'a critic must not change the work it judges';
const DEFAULT_CRITIC_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_SECONDS = 600;
const ESCALATION_OUTPUT_CHARS = 4000;

/** An agent step carries `task`, `run` and `stepRowId` so the driver can run a full session turn; a critic request carries none. */
export interface AgentDriveRequest<S extends EngineSubject = TaskRow> extends CriticDriveRequest {
  task?: S;
  run?: AttemptRow;
  stepRowId?: number;
}

export interface AgentDriveResult extends CriticDriveResult {
  /** The turn did not finish: 'paused' by the operator, 'settled' by a guardrail trip or cancel. */
  halt?: 'paused' | 'settled';
  /** The agent asked to escalate with this reason. */
  escalate?: string;
}

export interface AgentDrive<S extends EngineSubject = TaskRow> {
  run(req: AgentDriveRequest<S>): Promise<AgentDriveResult>;
}

export interface WorkflowEngineDeps<S extends EngineSubject = TaskRow> {
  library: { getVersion(name: string, version: number): Promise<WorkflowEntry> };
  stepRuns: WorkflowStepRunStore;
  spawn: CommandSpawn;
  secrets: (task: S) => Promise<Record<string, string>>;
  workspaceName?: (task: S) => Promise<string>;
  cwdFor: (task: S) => string;
  baseBranchFor: (task: S) => Promise<string>;
  mergeBranch?: (task: S, run: AttemptRow) => Promise<MergeIntoBaseOutcome>;
  openPullRequest?: (task: S, run: AttemptRow) => Promise<string | null>;
  closeTicket?: (task: S, comment: string | undefined) => Promise<boolean>;
  markTicketClosePending?: (task: S) => Promise<void>;
  commentOnTicket?: (task: S, body: string) => Promise<boolean>;
  escalate: (task: S, run: AttemptRow, reason: string) => Promise<void>;
  complete: (task: S, run: AttemptRow) => Promise<void>;
  onStepChanged?: (owner: StepRunOwner) => void;
  boundary?: (task: S) => Promise<boolean>;
  agent: {
    drive: AgentDrive<S>;
    getConfig: () => Pick<AppConfig, 'harnesses'>;
    prompts: () => EnginePrompts;
    route: (task: S) => Promise<ResolvedRoute>;
    resolveOption: (task: S, code: string) => Promise<ModelOptionResolution>;
    resolvePrompt: (text: string) => Promise<string>;
    promptFields: (task: S) => Promise<DriveFields & Record<string, string>>;
    healFields?: (task: S, heal: { reason: string; output: string }) => { reason: string; output: string };
    timeoutMs?: number;
    criticTimeoutMs?: number;
  };
  runTimeoutMs?: number;
  /** Opens the pod a workflow with a Kubernetes `runs_on` runs its shell steps in; absent runs every workflow locally. */
  pods?: PodOpener<S>;
}

interface StepResult {
  outcome: WorkflowStepOutcome;
  summary: string;
  stdout: string;
  exitCode: number | null;
  output: string;
  outputs?: Partial<WorkflowStepOutputs>;
  configFailure?: true;
  halt?: true;
}

type FailedStep = StepResult & { stepId: string };

interface StepFailure {
  outcome: WorkflowStepOutcome;
  reason: string;
  output: string;
  configFailure?: true;
}

interface AgentRunState {
  route?: Promise<ResolvedRoute>;
  session?: { key: string; id: string };
}

interface RunContext<S extends EngineSubject> {
  task: S;
  run: AttemptRow;
  ref: string;
  secrets: string[];
  latest: Map<string, { outcome: WorkflowStepOutcome | null }>;
  stepsContext: Record<string, Value>;
  context: ExpressionContext;
  agentState: AgentRunState;
  halted: boolean;
  pod?: PodSession;
  podTarget?: string;
}

interface GitMark {
  head: string;
  branch: string;
  branchOid: string | null;
  commits: number;
}

const stepIds = (steps: readonly WorkflowStepDefinition[]): string[] => steps.flatMap((step) => [step.id, ...(step.parallel ?? []).map((child) => child.id)]);

export function parseWorkflowRef(ref: string): { name: string; version: number } {
  const at = ref.lastIndexOf('@');
  return { name: ref.slice(0, at), version: Number(ref.slice(at + 1)) };
}

export class WorkflowEngine<S extends EngineSubject = TaskRow> {
  private readonly warmSessions = new Map<string, { key: string; id: string }>();

  private readonly healOutput = new Map<string, string>();

  constructor(private readonly deps: WorkflowEngineDeps<S>) {}

  private async prepare(task: S, run: AttemptRow, reuseSession = false): Promise<{ workflow: ReturnType<typeof parseWorkflow>; ctx: RunContext<S> }> {
    const ref = task.workflowRef!;
    const { name, version } = parseWorkflowRef(ref);
    const workflow = parseWorkflow((await this.deps.library.getVersion(name, version)).text, { lenient: true });
    const latest = await this.deps.stepRuns.latestByStep(stepRunOwner(task), ref);
    const secretMap = await this.deps.secrets(task);
    const stepsContext: Record<string, Value> = {};
    for (const [stepId, prior] of latest) {
      if (prior.outcome === null) continue;
      stepsContext[stepId] = { outcome: prior.outcome, outputs: prior.outputs ? (JSON.parse(prior.outputs) as Value) : {} };
    }
    const context: ExpressionContext = {
      steps: stepsContext,
      ticket: { title: task.trackerTitle ?? task.prompt, body: task.trackerBody ?? '', labels: task.trackerLabels ?? [], ref: task.trackerRef ?? '', origin: task.origin },
      attempt: { number: run.number, previousVerdict: '', failureReason: run.feedback ?? task.feedback ?? '' },
      workspace: { id: task.workspaceId ?? null, name: (await this.deps.workspaceName?.(task)) ?? '' },
      vars: snapshotVars(task.workflowVars, workflow.vars),
      secrets: secretMap,
    };
    const warm = reuseSession ? this.warmSessions.get(stepRunOwnerKey(stepRunOwner(task))) : undefined;
    const ctx: RunContext<S> = { task, run, ref, secrets: Object.values(secretMap), latest, stepsContext, context, agentState: warm ? { session: warm } : {}, halted: false };
    return { workflow, ctx };
  }

  /** `resumed` false marks a Retry: the counter and later steps start over. */
  async run(task: S, run: AttemptRow, resumed = true, reuseSession = true): Promise<void> {
    const { workflow, ctx } = await this.prepare(task, run, reuseSession);
    const runsOn = workflow.runsOn;
    if (runsOn !== undefined && runsOn !== LOCAL_TARGET && this.deps.pods) {
      try {
        ctx.pod = await this.deps.pods.open(task, { runsOn, image: workflow.image, source: 'workflow' });
        ctx.podTarget = runsOn;
      } catch (error) {
        await this.deps.escalate(task, run, maskSecrets(`Execution Target ${runsOn} could not start the Ticket's pod: ${errorMessage(error)}`, ctx.secrets));
        return;
      }
    }
    try {
      await this.runWorkflow(ctx, workflow, resumed);
    } finally {
      await ctx.pod?.dispose();
    }
  }

  private async runWorkflow(ctx: RunContext<S>, workflow: ReturnType<typeof parseWorkflow>, resumed: boolean): Promise<void> {
    const { task, run } = ctx;
    const { start, end } = workflow.attempts;
    if (!resumed) {
      for (const id of stepIds(workflow.steps.slice(start))) {
        ctx.latest.delete(id);
        delete ctx.stepsContext[id];
      }
    }
    if (await this.runSteps(ctx, workflow.steps.slice(0, start), 0, 'escalate')) return;
    if (ctx.halted) return;
    if (!(await this.runAttemptsBlock(ctx, workflow, workflow.steps.slice(start, end), !resumed))) return;
    if (await this.runSteps(ctx, workflow.steps.slice(end), end, 'escalate')) return;
    if (ctx.halted) return;
    await this.deps.complete(task, run);
    await this.runSteps(ctx, workflow.cleanup ?? [], workflow.steps.length, 'record');
    this.warmSessions.delete(stepRunOwnerKey(stepRunOwner(task)));
  }

  async acceptFailed(task: S): Promise<void> {
    await this.deps.stepRuns.acceptFailed(stepRunOwner(task), task.workflowRef!);
    this.deps.onStepChanged?.(stepRunOwner(task));
  }

  async close(task: S, run: AttemptRow): Promise<void> {
    const { workflow, ctx } = await this.prepare(task, run);
    this.warmSessions.delete(stepRunOwnerKey(stepRunOwner(task)));
    await this.runSteps(ctx, workflow.cleanup ?? [], workflow.steps.length, 'record');
  }

  private async runAttemptsBlock(ctx: RunContext<S>, workflow: ReturnType<typeof parseWorkflow>, body: readonly WorkflowStepDefinition[], fresh: boolean): Promise<boolean> {
    try {
      return await this.attemptsLoop(ctx, workflow, body, fresh);
    } finally {
      this.healOutput.delete(stepRunOwnerKey(stepRunOwner(ctx.task)));
    }
  }

  private async attemptsLoop(ctx: RunContext<S>, workflow: ReturnType<typeof parseWorkflow>, body: readonly WorkflowStepDefinition[], fresh: boolean): Promise<boolean> {
    const max = resolveAttemptsMax(workflow.attempts.max, snapshotVars(ctx.task.workflowVars, workflow.vars));
    if (!max.ok) {
      await this.deps.escalate(ctx.task, ctx.run, `workflow refused: ${max.message}`);
      return false;
    }
    const resume = fresh ? { number: 1, advance: false, previousVerdict: '', failureReason: (ctx.context.attempt as { failureReason: Value }).failureReason, failureOutput: '' } : await this.resumePoint(ctx, body, max.value);
    let { previousVerdict, failureReason, failureOutput } = resume;
    for (let number = resume.number; number <= max.value; number++) {
      ctx.context = { ...ctx.context, attempt: { number, previousVerdict, failureReason } };
      this.healOutput.set(stepRunOwnerKey(stepRunOwner(ctx.task)), failureOutput);
      if (number > resume.number || resume.advance) {
        for (const id of stepIds(body)) {
          ctx.latest.delete(id);
          delete ctx.stepsContext[id];
        }
      }
      const failure = await this.runSteps(ctx, body, workflow.attempts.start, 'return', number);
      if (failure === null) return !ctx.halted;
      if (failure.outcome === 'conflict' || failure.configFailure) return false;
      previousVerdict = failure.outcome;
      failureReason = failure.reason;
      failureOutput = failure.output;
    }
    await this.deps.escalate(ctx.task, ctx.run, `workflow attempts exhausted after ${max.value}: ${String(failureReason)}${failureOutput ? `\n${failureOutput}` : ''}`);
    return false;
  }

  private async resumePoint(ctx: RunContext<S>, body: readonly WorkflowStepDefinition[], max: number): Promise<{ number: number; advance: boolean; previousVerdict: string; failureReason: Value; failureOutput: string }> {
    const initial = (ctx.context.attempt as { failureReason: Value }).failureReason;
    const fresh = { number: 1, advance: false, previousVerdict: '', failureReason: initial, failureOutput: '' };
    const all = (await this.deps.stepRuns.listForOwner(stepRunOwner(ctx.task))).filter((row) => row.workflowRef === ctx.ref && row.attempt !== null);
    const passStart = all.findLastIndex((row, index) => index > 0 && row.attempt! < all[index - 1]!.attempt!);
    const rows = passStart < 0 ? all : all.slice(passStart);
    if (rows.length === 0) return fresh;
    const last = Math.max(...rows.map((row) => row.attempt!));
    const isFailure = (outcome: WorkflowStepOutcome | null): boolean => outcome === 'fail' || outcome === 'inconclusive' || outcome === 'conflict';
    const failureIn = (attempt: number) => rows.findLast((row) => row.attempt === attempt && isFailure(row.outcome));
    const open = stepIds(body).some((id) => isFailure(ctx.latest.get(id)?.outcome ?? null));
    if (open) {
      if (last >= max) return fresh;
      const failed = failureIn(last)!;
      return { number: last + 1, advance: true, previousVerdict: failed.outcome!, failureReason: `workflow step ${failed.stepId} ${failed.outcome}: ${failed.summary ?? ''}`, failureOutput: '' };
    }
    const earlier = last > 1 ? failureIn(last - 1) : undefined;
    return { number: last, advance: false, previousVerdict: earlier?.outcome ?? '', failureReason: earlier ? `workflow step ${earlier.stepId} ${earlier.outcome}: ${earlier.summary ?? ''}` : initial, failureOutput: '' };
  }

  /** Runs `steps`; on a non-pass outcome 'escalate' escalates and stops, 'return' hands the failure back to the attempts loop (a conflict still escalates), 'record' keeps going. Returns the failure that stopped the run, if any. */
  private async runSteps(ctx: RunContext<S>, steps: readonly WorkflowStepDefinition[], firstPosition: number, onFailure: 'escalate' | 'return' | 'record', attempt: number | null = null): Promise<StepFailure | null> {
    const { task, run } = ctx;
    for (const [index, step] of steps.entries()) {
      if (onFailure !== 'record' && (await this.deps.boundary?.(task))) {
        ctx.halted = true;
        return null;
      }
      if (ctx.halted) return null;
      const failed = step.parallel ? await this.runGroup(ctx, step, firstPosition + index, attempt) : await this.runStep(ctx, step, firstPosition + index, attempt);
      if (failed === null) continue;
      if (failed.outcome === 'conflict') await Git.abortRebase(this.deps.cwdFor(task));
      if (onFailure === 'record') continue;
      const tail = failed.output.length > ESCALATION_OUTPUT_CHARS ? failed.output.slice(-ESCALATION_OUTPUT_CHARS) : failed.output;
      const reason = `workflow step ${failed.stepId} ${failed.outcome}: ${failed.summary}`;
      const flag = failed.configFailure ? { configFailure: true as const } : {};
      if (onFailure === 'return' && failed.outcome !== 'conflict' && !failed.configFailure) return { outcome: failed.outcome, reason, output: tail, ...flag };
      await this.deps.escalate(task, run, `${reason}${tail ? `\n${tail}` : ''}`);
      return { outcome: failed.outcome, reason, output: tail, ...flag };
    }
    return null;
  }

  private async runStep(ctx: RunContext<S>, step: WorkflowStepDefinition, position: number, attempt: number | null, groupCondition?: string): Promise<FailedStep | null> {
    const { task, run, ref, secrets, latest, stepsContext, context } = ctx;
    const mask = (text: string): string => maskSecrets(text, secrets);
    const prior = latest.get(step.id)?.outcome;
    if (prior === 'pass' || prior === 'skipped') return null;
    const action = step.run !== undefined ? 'run' : step.uses!;
    const row = await this.deps.stepRuns.start({ ...stepRunOwner(task), workflowRef: ref, stepId: step.id, position, action, attempt });
    this.deps.onStepChanged?.(stepRunOwner(task));
    let result: StepResult;
    let pod: PodSession | undefined;
    try {
      const falsy = [groupCondition, step.if].find((condition) => condition !== undefined && !evaluateCondition(condition, context));
      if (falsy !== undefined) {
        result = { outcome: 'skipped', summary: `if: ${falsy.trim()} was false`, stdout: '', exitCode: null, output: '' };
      } else {
        const [resolved, env] = resolveStep(step, context);
        pod = this.podFor(ctx, resolved);
        result =
          resolved.uses === 'agent'
            ? await this.executeAgent(ctx, resolved, row.id)
            : resolved.uses === 'critic'
              ? await this.executeCritic(task, resolved, row.id, secrets, context)
              : await this.execute(task, run, resolved, env, secrets, pod);
      }
    } catch (error) {
      result = { outcome: 'inconclusive', summary: mask(errorMessage(error)), stdout: '', exitCode: null, output: '' };
    }
    if (result.halt) {
      ctx.halted = true;
      return null;
    }
    if (pod && result.outcome !== 'skipped') result = await this.checkpointed(pod, result, mask);
    const outputs: WorkflowStepOutputs = { stdout: result.stdout, exitCode: result.exitCode, ...result.outputs };
    await this.deps.stepRuns.finish(row.id, { outcome: result.outcome, outputs, summary: result.summary });
    stepsContext[step.id] = { outcome: result.outcome, outputs: outputs as unknown as Value };
    this.deps.onStepChanged?.(stepRunOwner(task));
    return result.outcome === 'pass' || result.outcome === 'skipped' ? null : { stepId: step.id, ...result };
  }

  private podFor(ctx: RunContext<S>, step: WorkflowStepDefinition): PodSession | undefined {
    if (!ctx.pod) return undefined;
    const shell = step.uses === 'rebase' || (step.run !== undefined && (step.uses === undefined || step.uses === 'command'));
    return shell && (step.runs_on === undefined || step.runs_on === ctx.podTarget) ? ctx.pod : undefined;
  }

  private async checkpointed(pod: PodSession, result: StepResult, mask: (text: string) => string): Promise<StepResult> {
    let checkpoint;
    try {
      checkpoint = await pod.checkpoint();
    } catch (error) {
      checkpoint = { branch: '', sha: null, forced: false, unchanged: false, error: errorMessage(error) };
    }
    const recorded = checkpoint.error === undefined ? checkpoint : { ...checkpoint, error: mask(checkpoint.error) };
    const outputs = { ...result.outputs, checkpoint: recorded };
    if (recorded.error === undefined || result.outcome !== 'pass') return { ...result, outputs };
    return { ...result, outcome: 'inconclusive', summary: `checkpoint push failed: ${recorded.error}`, outputs };
  }

  private async runGroup(ctx: RunContext<S>, group: WorkflowStepDefinition, position: number, attempt: number | null): Promise<FailedStep | null> {
    const failures = (await Promise.all((group.parallel ?? []).map((step) => this.runStep(ctx, step, position, attempt, group.if)))).filter((failure): failure is FailedStep => failure !== null);
    if (failures.length === 0) return null;
    const rank: WorkflowStepOutcome[] = ['conflict', 'fail', 'inconclusive'];
    const outcome = rank.find((candidate) => failures.some((f) => f.outcome === candidate))!;
    return {
      stepId: group.id,
      outcome,
      summary: failures.map((f) => `${f.stepId} ${f.outcome}: ${f.summary}`).join('; '),
      stdout: '',
      exitCode: null,
      output: failures.map((f) => f.output).filter((text) => text !== '').join('\n'),
      ...(failures.some((f) => f.configFailure) ? { configFailure: true as const } : {}),
    };
  }

  private async executeCritic(task: S, step: WorkflowStepDefinition, rowId: number, secrets: string[], context: ExpressionContext): Promise<StepResult> {
    const mask = (text: string): string => maskSecrets(text, secrets);
    const inconclusive = (summary: string): StepResult => ({ outcome: 'inconclusive', summary: mask(summary), stdout: '', exitCode: null, output: '' });
    try {
      const options = criticStepWith(step.with);
      if (!options) return inconclusive('invalid critic step options: a critic needs its own prompt and either an option or a harness and model');
      const { agent } = this.deps;
      let route: ResolvedRoute;
      if (options.option !== undefined) {
        const picked = await this.optionRoute(task, options.option, step.id);
        if ('failure' in picked) return { ...picked.failure, summary: mask(picked.failure.summary) };
        route = picked.route;
      } else {
        route = resolveRoute(agent.getConfig(), options.harness!, options.model!, null);
      }
      if (!route.ok) return inconclusive(route.reason);
      const prompt = buildWorkflowCriticPrompt(await this.renderPrompt(options.prompt, await this.promptFields(task, context, route), context), agent.prompts());
      await this.deps.stepRuns.setResolvedPrompt(rowId, mask(prompt));
      this.deps.onStepChanged?.(stepRunOwner(task));
      const cwd = this.deps.cwdFor(task);
      const before = await markGit(cwd);
      const dirtyBefore = await Git.isDirty(cwd);
      const result = await agent.drive.run({
        harness: route.config,
        harnessId: route.harness,
        model: route.model,
        cwd,
        prompt,
        timeoutMs: agent.criticTimeoutMs ?? DEFAULT_CRITIC_TIMEOUT_MS,
        readOnly: true,
      });
      const output = mask(result.output);
      const after = await markGit(cwd);
      const changed = before.head !== after.head || before.branch !== after.branch || before.branchOid !== after.branchOid || before.commits !== after.commits || (!dirtyBefore && (await Git.isDirty(cwd)));
      if (changed) return { outcome: 'fail', summary: CRITIC_CHANGED_THE_WORK, stdout: output, exitCode: null, output, outputs: { verdict: 'fail', reason: CRITIC_CHANGED_THE_WORK } };
      const parsed = parseCriticOutput(result.output);
      if (!parsed.ok) return { outcome: 'inconclusive', summary: mask(parsed.reason), stdout: output, exitCode: null, output, outputs: { verdict: 'inconclusive', reason: mask(parsed.reason) } };
      const { verdict, summary, findings } = parsed.value;
      return { outcome: verdict, summary: mask(summary), stdout: output, exitCode: null, output, outputs: { verdict, reason: mask(summary), findings: (findings ?? []).map(mask) } };
    } catch (error) {
      return inconclusive(errorMessage(error));
    }
  }

  private async renderPrompt(text: string, fields: Record<string, string | number>, context: ExpressionContext): Promise<string> {
    const spans = findInterpolations(text);
    if (spans.length === 1 && spans[0]!.start === text.search(/\S/) && text.trimEnd().length === spans[0]!.end) {
      const picked = interpolate(text, context).trim();
      if (PROMPT_CODE_PATTERN.test(picked)) return renderAgentPrompt(await this.deps.agent.resolvePrompt(picked), fields, context);
    }
    return renderAgentPrompt(await this.deps.agent.resolvePrompt(text), fields, context);
  }

  private async promptFields(task: S, context: ExpressionContext, route: { harness: string; model: string }): Promise<Record<string, string | number>> {
    const attempt = context.attempt as { number: number; failureReason: string };
    const healing = attempt.number > 1;
    const heal = healing ? { reason: attempt.failureReason, output: this.healOutput.get(stepRunOwnerKey(stepRunOwner(task))) ?? '' } : { reason: '', output: '' };
    const shaped = healing && this.deps.agent.healFields ? this.deps.agent.healFields(task, heal) : heal;
    return {
      ...(await this.deps.agent.promptFields(task)),
      prompt: task.prompt,
      id: task.id ?? task.epicRef ?? '',
      workingDir: this.deps.cwdFor(task),
      harness: route.harness,
      model: route.model,
      feedback: appendFeedback('', task.feedback),
      attempt: attempt.number - 1,
      reason: shaped.reason,
      output: shaped.output,
    };
  }

  private async rebase(task: S, mask: (text: string) => string): Promise<StepResult> {
    const cwd = this.deps.cwdFor(task);
    if (cwd === task.workingDir) return { outcome: 'pass', summary: 'the Ticket works in place', stdout: '', exitCode: null, output: '' };
    const baseOid = await Git.revParse(task.workingDir, await this.deps.baseBranchFor(task));
    const rebased = await Git.rebaseOnto(cwd, baseOid);
    if (rebased.ok) return { outcome: 'pass', summary: `rebased onto ${baseOid}`, stdout: '', exitCode: 0, output: '', outputs: { baseSha: baseOid, conflictedFiles: [] } };
    const detail = mask(rebased.detail);
    if (!rebased.conflict) return { outcome: 'inconclusive', summary: detail, stdout: '', exitCode: null, output: detail, outputs: { baseSha: baseOid, conflictedFiles: [] } };
    const conflictedFiles = await Git.conflictedFiles(cwd);
    return { outcome: 'conflict', summary: `rebase conflict in ${conflictedFiles.join(', ') || 'the working copy'}`, stdout: '', exitCode: null, output: detail, outputs: { baseSha: baseOid, conflictedFiles } };
  }

  private async rebaseInPod(pod: PodSession, mask: (text: string) => string): Promise<StepResult> {
    const rebased = await pod.rebase();
    if (rebased.ok) return { outcome: 'pass', summary: `rebased onto ${rebased.baseSha}`, stdout: '', exitCode: 0, output: '', outputs: { baseSha: rebased.baseSha, conflictedFiles: [] } };
    const detail = mask(rebased.detail);
    const outputs = { ...(rebased.baseSha === null ? {} : { baseSha: rebased.baseSha }), conflictedFiles: rebased.conflictedFiles };
    if (!rebased.conflict) return { outcome: 'inconclusive', summary: detail, stdout: '', exitCode: null, output: detail, outputs };
    return { outcome: 'conflict', summary: `rebase conflict in ${rebased.conflictedFiles.join(', ') || 'the working copy'}`, stdout: '', exitCode: null, output: detail, outputs };
  }

  private async runInPod(pod: PodSession, step: WorkflowStepDefinition, env: Record<string, string>, mask: (text: string) => string): Promise<StepResult> {
    const result = await pod.run(step.run!, env, this.deps.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_SECONDS * 1000);
    const output = result.stdout + result.stderr;
    const verdict = exitCodeToVerdict({ code: result.code, signal: null, timedOut: result.timedOut, output, stdout: result.stdout });
    return { outcome: verdict.verdict, summary: mask(verdict.summary), stdout: mask(result.stdout), exitCode: result.code, output: mask(output) };
  }

  private async executeBranchAction(task: S, run: AttemptRow, action: 'merge' | 'open-pr' | 'artifact'): Promise<StepResult> {
    const done = (outcome: WorkflowStepOutcome, summary: string, outputs?: Partial<WorkflowStepOutputs>): StepResult => ({
      outcome,
      summary,
      stdout: '',
      exitCode: null,
      output: '',
      ...(outputs ? { outputs } : {}),
    });
    if (run.branch == null || run.baseBranch == null) {
      const inPlace = action !== 'open-pr' && this.deps.cwdFor(task) === task.workingDir;
      return inPlace ? done('pass', 'the Ticket works in place') : done('inconclusive', 'the Ticket has no branch');
    }
    if (action === 'artifact') return done('pass', `kept branch ${run.branch} as an artifact`, { branch: run.branch });
    if (action === 'merge') {
      if (!this.deps.mergeBranch) return done('inconclusive', 'merge is not available');
      const merged = await this.deps.mergeBranch(task, run);
      if (merged.ok) return done('pass', `merged ${run.branch} into ${run.baseBranch}`, { branch: run.branch });
      return done(merged.reason === 'conflict' ? 'conflict' : 'fail', merged.detail);
    }
    if (!this.deps.openPullRequest) return done('inconclusive', 'open-pr is not available');
    const url = await this.deps.openPullRequest(task, run);
    if (url === null) return done('inconclusive', 'no pull request was opened: the repository has no forge to open one on');
    const number = pullRequestNumber(url);
    return done('pass', `opened ${url}`, { url, ...(number === null ? {} : { number }) });
  }

  private async optionRoute(task: S, code: string, stepId: string): Promise<{ route: ResolvedRoute } | { failure: StepResult }> {
    const resolved = await this.deps.agent.resolveOption(task, code);
    if (resolved.kind === 'miss') {
      return { failure: { outcome: 'inconclusive', summary: `step ${stepId} names model option '${code}', which is ${resolved.reason} for this Ticket; the step does not fall back to another route`, stdout: '', exitCode: null, output: '', configFailure: true } };
    }
    return { route: resolveRoute(this.deps.agent.getConfig(), resolved.option.harness, resolved.option.model, null) };
  }

  private async executeAgent(ctx: RunContext<S>, step: WorkflowStepDefinition, rowId: number): Promise<StepResult> {
    const { task, run, secrets, agentState: state, context } = ctx;
    const mask = (text: string): string => maskSecrets(text, secrets);
    const inconclusive = (summary: string): StepResult => ({ outcome: 'inconclusive', summary: mask(summary), stdout: '', exitCode: null, output: '' });
    try {
      const options = agentStepWith(step.with);
      if (!options) return inconclusive('invalid agent step options');
      const { agent } = this.deps;
      let route: ResolvedRoute;
      if (options.option !== undefined) {
        const picked = await this.optionRoute(task, options.option, step.id);
        if ('failure' in picked) return { ...picked.failure, summary: mask(picked.failure.summary) };
        route = picked.route;
      } else if (options.harness === undefined && options.model === undefined) {
        state.route ??= agent.route(task);
        route = await state.route;
      } else {
        const needsRoute = options.harness === undefined || options.model === undefined;
        const implicit = needsRoute ? await (state.route ??= agent.route(task)) : undefined;
        if (implicit && !implicit.ok) return inconclusive(implicit.reason);
        const harness = options.harness ?? implicit!.harness;
        const model = options.model ?? (implicit && options.harness === undefined ? implicit.model : harnessConfig(agent.getConfig(), harness)?.defaultModel ?? '');
        route = resolveRoute(agent.getConfig(), harness, model, null);
      }
      if (!route.ok) return inconclusive(route.reason);
      const fields = await this.promptFields(task, context, route);
      const prompt = options.prompt === undefined ? await agent.resolvePrompt(task.prompt) : await this.renderPrompt(options.prompt, fields, context);
      await this.deps.stepRuns.setResolvedPrompt(rowId, mask(prompt));
      this.deps.onStepChanged?.(stepRunOwner(task));
      const cwd = this.deps.cwdFor(task);
      const key = `${route.harness}\u0000${route.model}`;
      let output = '';
      let text = prompt;
      const nudges = options.continueAttempts ?? 0;
      for (let turn = 0; ; turn++) {
        const result = await agent.drive.run({
          harness: route.config,
          harnessId: route.harness,
          model: route.model,
          cwd,
          prompt: text,
          timeoutMs: agent.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
          task,
          run,
          stepRowId: rowId,
          ...(state.session?.key === key ? { continueSessionId: state.session.id } : {}),
        });
        if (result.sessionId) {
          state.session = { key, id: result.sessionId };
          this.warmSessions.set(stepRunOwnerKey(stepRunOwner(task)), state.session);
        }
        if (result.halt) return { outcome: 'inconclusive', summary: `agent turn ${result.halt}`, stdout: '', exitCode: null, output: '', halt: true };
        if (result.escalate !== undefined) return { ...inconclusive(result.escalate), configFailure: true };
        output += result.output;
        if (!(await Git.isDirty(cwd).catch(() => false))) break;
        if (turn >= nudges) return { outcome: 'fail', summary: UNCOMMITTED_AFTER_AGENT, stdout: mask(output), exitCode: null, output: mask(output) };
        text = options.continuePrompt === undefined ? DEFAULT_CONTINUE_PROMPT : await this.renderPrompt(options.continuePrompt, fields, context);
      }
      return { outcome: 'pass', summary: `agent turn finished on ${route.harness}/${route.model}`, stdout: mask(output), exitCode: null, output: mask(output) };
    } catch (error) {
      return inconclusive(errorMessage(error));
    }
  }

  private async postMergeCheck(task: S, run: AttemptRow, step: WorkflowStepDefinition, env: Record<string, string>, secrets: string[]): Promise<StepResult> {
    const mask = (text: string): string => maskSecrets(text, secrets);
    const script = step.with?.run;
    if (typeof script !== 'string' || script === '') return { outcome: 'pass', summary: 'no post-merge commands configured', stdout: '', exitCode: null, output: '' };
    const command: VerificationCommand = { id: step.id, command: 'sh', args: ['-c', script], env, timeoutSeconds: DEFAULT_RUN_TIMEOUT_SECONDS };
    const base = run.baseBranch ?? (await this.deps.baseBranchFor(task));
    const scratch = await mkdtemp(join(tmpdir(), 'harmonic-post-merge-'));
    const checkout = join(scratch, 'base');
    try {
      await Git.addDetachedWorktree(task.workingDir, checkout, base);
      const result = await this.deps.spawn.run({ command, cwd: checkout, timeoutMs: this.deps.runTimeoutMs ?? command.timeoutSeconds * 1000, outputCap: OUTPUT_CHAR_CAP });
      const verdict = exitCodeToVerdict(result);
      return { outcome: verdict.verdict, summary: mask(verdict.summary), stdout: mask(result.stdout), exitCode: result.code, output: mask(result.output) };
    } finally {
      await Git.removeWorktree(task.workingDir, checkout).catch(() => undefined);
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private async cleanup(task: S, run: AttemptRow): Promise<StepResult> {
    const done = (outcome: WorkflowStepOutcome, summary: string): StepResult => ({ outcome, summary, stdout: '', exitCode: null, output: '' });
    const worktree = this.deps.cwdFor(task);
    if (worktree === task.workingDir) return done('pass', 'the Ticket has no worktree to retire');
    const removed = await Git.removeWorktreeAndDeleteBranch(task.workingDir, worktree, run.branch, async () => true);
    return done('pass', removed ? `retired ${worktree}${run.branch ? ` and branch ${run.branch}` : ''}` : 'nothing to retire');
  }

  private async trackerAction(task: S, step: WorkflowStepDefinition): Promise<StepResult> {
    const done = (outcome: WorkflowStepOutcome, summary: string): StepResult => ({ outcome, summary, stdout: '', exitCode: null, output: '' });
    const text = typeof step.with?.body === 'string' ? step.with.body : '';
    if (step.uses === 'comment') {
      if (text === '') return done('inconclusive', 'comment needs with.body');
      if (!this.deps.commentOnTicket) return done('inconclusive', 'comment is not available');
      return (await this.deps.commentOnTicket(task, text)) ? done('pass', 'commented on the ticket') : done('inconclusive', 'the ticket could not be commented on: no tracker ticket or the tracker cannot comment');
    }
    if (!this.deps.closeTicket) return done('inconclusive', 'close-ticket is not available');
    if (task.trackerRef == null) return done('pass', 'the Task has no tracker ticket to close');
    const closed = await this.deps.closeTicket(task, text === '' ? undefined : text).catch(() => false);
    if (closed) return done('pass', 'closed the ticket');
    await this.deps.markTicketClosePending?.(task);
    return done('pass', 'the tracker refused to close the ticket; the close will be retried');
  }

  private async runGuarded(task: S, command: VerificationCommand, mask: (text: string) => string): Promise<StepResult> {
    const cwd = this.deps.cwdFor(task);
    const before = await markGit(cwd);
    const result = await this.deps.spawn.run({
      command,
      cwd: command.cwd ? join(cwd, command.cwd) : cwd,
      timeoutMs: this.deps.runTimeoutMs ?? command.timeoutSeconds * 1000,
      outputCap: OUTPUT_CHAR_CAP,
    });
    const after = await markGit(cwd);
    const verdict = exitCodeToVerdict(result);
    const moved = before.head !== after.head || before.branch !== after.branch || before.branchOid !== after.branchOid || before.commits !== after.commits;
    return {
      outcome: moved ? 'fail' : verdict.verdict,
      summary: moved ? ONLY_THE_AGENT_COMMITS : mask(verdict.summary),
      stdout: mask(result.stdout),
      exitCode: result.code,
      output: mask(result.output),
    };
  }

  private async execute(task: S, run: AttemptRow, step: WorkflowStepDefinition, env: Record<string, string>, secrets: string[], pod?: PodSession): Promise<StepResult> {
    const mask = (text: string): string => maskSecrets(text, secrets);
    try {
      if (pod && step.uses === 'rebase') return await this.rebaseInPod(pod, mask);
      if (pod) return await this.runInPod(pod, step, env, mask);
      if (step.uses === 'rebase') return await this.rebase(task, mask);
      if (step.uses === 'verify') return { outcome: 'pass', summary: 'no verification commands configured', stdout: '', exitCode: null, output: '' };
      if (step.uses === 'post-merge-check') return await this.postMergeCheck(task, run, step, env, secrets);
      if (step.uses === 'cleanup') return await this.cleanup(task, run);
      if (step.uses === 'comment' || step.uses === 'close-ticket') return await this.trackerAction(task, step);
      if (step.uses === 'merge' || step.uses === 'open-pr' || step.uses === 'artifact') return await this.executeBranchAction(task, run, step.uses);
      if (step.run === undefined) {
        return { outcome: 'inconclusive', summary: 'action not yet supported', stdout: '', exitCode: null, output: '' };
      }
      const command: VerificationCommand = { id: step.id, command: 'sh', args: ['-c', step.run], env, timeoutSeconds: DEFAULT_RUN_TIMEOUT_SECONDS };
      return await this.runGuarded(task, command, mask);
    } catch (error) {
      return { outcome: 'inconclusive', summary: mask(errorMessage(error)), stdout: '', exitCode: null, output: '' };
    }
  }
}

/** Expression values reach a `run:` script as env vars, never as shell text, so ticket or step output cannot inject commands. */
function resolveStep(step: WorkflowStepDefinition, context: ExpressionContext): [WorkflowStepDefinition, Record<string, string>] {
  const env: Record<string, string> = {};
  const toEnv = (text: string): string =>
    interpolate(text, context, (value) => {
      const name = `HARMONIC_EXPR_${Object.keys(env).length}`;
      env[name] = value;
      return `"\${${name}}"`;
    });
  const rendersPrompt = step.uses === 'agent' || step.uses === 'critic';
  const withValues =
    step.with &&
    Object.fromEntries(
      Object.entries(step.with).map(([key, value]) => [key, typeof value !== 'string' || (rendersPrompt && (key === 'prompt' || key === 'continuePrompt')) ? value : step.uses === 'post-merge-check' && key === 'run' ? toEnv(value) : interpolate(value, context)]),
    );
  const run = step.run === undefined ? undefined : toEnv(step.run);
  return [{ ...step, run, with: withValues }, env];
}

async function markGit(cwd: string): Promise<GitMark> {
  const branch = await Git.currentBranch(cwd);
  return {
    head: await Git.revParse(cwd, 'HEAD'),
    branch,
    branchOid: branch === 'HEAD' ? null : await Git.revParse(cwd, `refs/heads/${branch}`),
    commits: await Git.commitCount(cwd, 'HEAD'),
  };
}

function pullRequestNumber(url: string): number | null {
  const match = /\/(\d+)\/?$/.exec(new URL(url).pathname);
  return match ? Number(match[1]) : null;
}
