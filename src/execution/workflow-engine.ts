import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, VerificationCommand } from '../config.js';
import type { AttemptRow, TaskRow, WorkflowStepOutcome } from '../db/schema.js';
import type { WorkflowEntry } from '../domain/workflow-library-store.js';
import { evaluateCondition, interpolate, type ExpressionContext, type Value } from '../domain/workflow-expression.js';
import { agentStepWith, criticStepWith, parseWorkflow, type WorkflowStepDefinition } from '../domain/workflow.js';
import { harnessConfig, resolveRoute, type ResolvedRoute } from '../domain/route.js';
import type { WorkflowStepOutputs, WorkflowStepRunStore } from '../domain/workflow-step-runs.js';
import { maskSecrets } from '../secrets/mask.js';
import { errorMessage } from '../error-handling.js';
import type { CriticHarnessDrive } from '../verification/critic.js';
import { exitCodeToVerdict, OUTPUT_CHAR_CAP, type CommandSpawn } from '../verification/command-verifier.js';
import type { MergeIntoBaseOutcome } from './branch-merge.js';
import { Git } from './git.js';
import { buildWorkflowCriticPrompt } from './prompt-assembly.js';
import { loadBaselineConfig } from '../config.js';
import { withEngineFragments } from '../domain/prompt-library-sources.js';
import { parseCriticOutput } from '../verification/critic-schema.js';

export const ONLY_THE_AGENT_COMMITS = 'only the agent commits';
export const UNCOMMITTED_AFTER_AGENT = 'uncommitted changes remain after the agent turn';
export const DEFAULT_CONTINUE_PROMPT = 'You have uncommitted changes in the worktree. Commit your work with a clear message, then stop.';
const DEFAULT_AGENT_TIMEOUT_MS = 60 * 60 * 1000;
export const CRITIC_CHANGED_THE_WORK = 'a critic must not change the work it judges';
const DEFAULT_CRITIC_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_SECONDS = 600;
const ESCALATION_OUTPUT_CHARS = 4000;

export interface WorkflowEngineDeps {
  library: { getVersion(name: string, version: number): Promise<WorkflowEntry> };
  stepRuns: WorkflowStepRunStore;
  spawn: CommandSpawn;
  commandById: (task: TaskRow, id: string) => Promise<VerificationCommand | undefined>;
  secrets: (task: TaskRow) => Promise<Record<string, string>>;
  workspaceName?: (task: TaskRow) => Promise<string>;
  cwdFor: (task: TaskRow) => string;
  baseBranchFor: (task: TaskRow) => Promise<string>;
  mergeBranch?: (task: TaskRow, run: AttemptRow) => Promise<MergeIntoBaseOutcome>;
  openPullRequest?: (task: TaskRow, run: AttemptRow) => Promise<string | null>;
  closeTicket?: (task: TaskRow, comment: string) => Promise<boolean>;
  commentOnTicket?: (task: TaskRow, body: string) => Promise<boolean>;
  escalate: (task: TaskRow, run: AttemptRow, reason: string) => Promise<void>;
  complete: (task: TaskRow, run: AttemptRow) => Promise<void>;
  onStepChanged?: (taskId: number) => void;
  agent: {
    drive: CriticHarnessDrive;
    getConfig: () => Pick<AppConfig, 'harnesses'>;
    route: (task: TaskRow) => Promise<ResolvedRoute>;
    resolvePrompt: (text: string) => Promise<string>;
    timeoutMs?: number;
    criticTimeoutMs?: number;
  };
  runTimeoutMs?: number;
}

interface StepResult {
  outcome: WorkflowStepOutcome;
  summary: string;
  stdout: string;
  exitCode: number | null;
  output: string;
  outputs?: Partial<WorkflowStepOutputs>;
}

type FailedStep = StepResult & { stepId: string };

interface AgentRunState {
  route?: Promise<ResolvedRoute>;
  session?: { key: string; id: string };
}

interface RunContext {
  task: TaskRow;
  run: AttemptRow;
  ref: string;
  secrets: string[];
  latest: Map<string, { outcome: WorkflowStepOutcome | null }>;
  stepsContext: Record<string, Value>;
  context: ExpressionContext;
  agentState: AgentRunState;
  criticFragments: ReturnType<typeof withEngineFragments>;
}

interface GitMark {
  head: string;
  branch: string;
  branchOid: string | null;
  commits: number;
}

export function parseWorkflowRef(ref: string): { name: string; version: number } {
  const at = ref.lastIndexOf('@');
  return { name: ref.slice(0, at), version: Number(ref.slice(at + 1)) };
}

export class WorkflowEngine {
  constructor(private readonly deps: WorkflowEngineDeps) {}

  /** Runs the Task's pinned workflow from the first step that has not passed; a failing step escalates the Task. */
  async run(task: TaskRow, run: AttemptRow): Promise<void> {
    const ref = task.workflowRef!;
    const { name, version } = parseWorkflowRef(ref);
    const workflow = parseWorkflow((await this.deps.library.getVersion(name, version)).text);
    const latest = await this.deps.stepRuns.latestByStep(task.id, ref);
    const secretMap = await this.deps.secrets(task);
    const stepsContext: Record<string, Value> = {};
    for (const [stepId, prior] of latest) {
      if (prior.outcome === null) continue;
      stepsContext[stepId] = { outcome: prior.outcome, outputs: prior.outputs ? (JSON.parse(prior.outputs) as Value) : {} };
    }
    const context: ExpressionContext = {
      steps: stepsContext,
      ticket: { title: task.trackerTitle ?? task.prompt, body: task.trackerBody ?? '', labels: task.trackerLabels ?? [], ref: task.trackerRef ?? '' },
      attempt: { number: run.number, failureReason: run.feedback ?? task.feedback ?? '' },
      workspace: { id: task.workspaceId ?? null, name: (await this.deps.workspaceName?.(task)) ?? '' },
      vars: workflow.vars,
      secrets: secretMap,
    };
    const ctx: RunContext = { task, run, ref, secrets: Object.values(secretMap), latest, stepsContext, context, agentState: {}, criticFragments: withEngineFragments(loadBaselineConfig().promptFragments) };
    if (!(await this.runSteps(ctx, workflow.steps, 0, true))) return;
    await this.deps.complete(task, run);
    await this.runSteps(ctx, workflow.cleanup ?? [], workflow.steps.length, false);
  }

  /** Runs `steps`; with `escalateOnFailure` a non-pass outcome escalates the Task and stops, otherwise the failure is recorded and the remaining steps still run. Returns whether the Task may continue. */
  private async runSteps(ctx: RunContext, steps: readonly WorkflowStepDefinition[], firstPosition: number, escalateOnFailure: boolean): Promise<boolean> {
    const { task, run } = ctx;
    for (const [index, step] of steps.entries()) {
      const failed = step.parallel ? await this.runGroup(ctx, step, firstPosition + index) : await this.runStep(ctx, step, firstPosition + index);
      if (failed === null) continue;
      if (failed.outcome === 'conflict') await Git.abortRebase(this.deps.cwdFor(task));
      if (!escalateOnFailure) continue;
      const tail = failed.output.length > ESCALATION_OUTPUT_CHARS ? failed.output.slice(-ESCALATION_OUTPUT_CHARS) : failed.output;
      await this.deps.escalate(task, run, `workflow step ${failed.stepId} ${failed.outcome}: ${failed.summary}${tail ? `\n${tail}` : ''}`);
      return false;
    }
    return true;
  }

  private async runStep(ctx: RunContext, step: WorkflowStepDefinition, position: number, groupCondition?: string): Promise<FailedStep | null> {
    const { task, run, ref, secrets, latest, stepsContext, context } = ctx;
    const mask = (text: string): string => maskSecrets(text, secrets);
    const prior = latest.get(step.id)?.outcome;
    if (prior === 'pass' || prior === 'skipped') return null;
    const action = step.run !== undefined ? 'run' : step.uses!;
    const row = await this.deps.stepRuns.start({ taskId: task.id, workflowRef: ref, stepId: step.id, position, action });
    this.deps.onStepChanged?.(task.id);
    let result: StepResult;
    try {
      const falsy = [groupCondition, step.if].find((condition) => condition !== undefined && !evaluateCondition(condition, context));
      if (falsy !== undefined) {
        result = { outcome: 'skipped', summary: `if: ${falsy.trim()} was false`, stdout: '', exitCode: null, output: '' };
      } else {
        const [resolved, env] = resolveStep(step, context);
        result =
          resolved.uses === 'agent'
            ? await this.executeAgent(task, resolved, row.id, secrets, ctx.agentState)
            : resolved.uses === 'critic'
              ? await this.executeCritic(task, resolved, row.id, secrets, ctx.criticFragments)
              : await this.execute(task, run, resolved, env, secrets);
      }
    } catch (error) {
      result = { outcome: 'inconclusive', summary: mask(errorMessage(error)), stdout: '', exitCode: null, output: '' };
    }
    const outputs: WorkflowStepOutputs = { stdout: result.stdout, exitCode: result.exitCode, ...result.outputs };
    await this.deps.stepRuns.finish(row.id, { outcome: result.outcome, outputs, summary: result.summary });
    stepsContext[step.id] = { outcome: result.outcome, outputs: outputs as unknown as Value };
    this.deps.onStepChanged?.(task.id);
    return result.outcome === 'pass' || result.outcome === 'skipped' ? null : { stepId: step.id, ...result };
  }

  private async runGroup(ctx: RunContext, group: WorkflowStepDefinition, position: number): Promise<FailedStep | null> {
    const failures = (await Promise.all((group.parallel ?? []).map((step) => this.runStep(ctx, step, position, group.if)))).filter((failure): failure is FailedStep => failure !== null);
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
    };
  }

  private async executeCritic(task: TaskRow, step: WorkflowStepDefinition, rowId: number, secrets: string[], fragments: RunContext['criticFragments']): Promise<StepResult> {
    const mask = (text: string): string => maskSecrets(text, secrets);
    const inconclusive = (summary: string): StepResult => ({ outcome: 'inconclusive', summary: mask(summary), stdout: '', exitCode: null, output: '' });
    try {
      const options = criticStepWith(step.with);
      if (!options) return inconclusive('invalid critic step options: a critic needs its own prompt, harness and model');
      const { agent } = this.deps;
      const route = resolveRoute(agent.getConfig(), options.harness, options.model, null);
      if (!route.ok) return inconclusive(route.reason);
      const prompt = buildWorkflowCriticPrompt(await agent.resolvePrompt(options.prompt), fragments);
      await this.deps.stepRuns.setResolvedPrompt(rowId, mask(prompt));
      this.deps.onStepChanged?.(task.id);
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

  private async rebase(task: TaskRow, mask: (text: string) => string): Promise<StepResult> {
    const cwd = this.deps.cwdFor(task);
    const baseOid = await Git.revParse(task.workingDir, await this.deps.baseBranchFor(task));
    const rebased = await Git.rebaseOnto(cwd, baseOid);
    if (rebased.ok) return { outcome: 'pass', summary: `rebased onto ${baseOid}`, stdout: '', exitCode: 0, output: '', outputs: { baseSha: baseOid, conflictedFiles: [] } };
    const detail = mask(rebased.detail);
    if (!rebased.conflict) return { outcome: 'inconclusive', summary: detail, stdout: '', exitCode: null, output: detail, outputs: { baseSha: baseOid, conflictedFiles: [] } };
    const conflictedFiles = await Git.conflictedFiles(cwd);
    return { outcome: 'conflict', summary: `rebase conflict in ${conflictedFiles.join(', ') || 'the working copy'}`, stdout: '', exitCode: null, output: detail, outputs: { baseSha: baseOid, conflictedFiles } };
  }

  private async executeBranchAction(task: TaskRow, run: AttemptRow, action: 'merge' | 'open-pr' | 'artifact'): Promise<StepResult> {
    const done = (outcome: WorkflowStepOutcome, summary: string, outputs?: Partial<WorkflowStepOutputs>): StepResult => ({
      outcome,
      summary,
      stdout: '',
      exitCode: null,
      output: '',
      ...(outputs ? { outputs } : {}),
    });
    if (run.branch == null || run.baseBranch == null) return done('inconclusive', 'the Ticket has no branch');
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

  private async executeAgent(task: TaskRow, step: WorkflowStepDefinition, rowId: number, secrets: string[], state: AgentRunState): Promise<StepResult> {
    const mask = (text: string): string => maskSecrets(text, secrets);
    const inconclusive = (summary: string): StepResult => ({ outcome: 'inconclusive', summary: mask(summary), stdout: '', exitCode: null, output: '' });
    try {
      const options = agentStepWith(step.with);
      if (!options) return inconclusive('invalid agent step options');
      const { agent } = this.deps;
      let route: ResolvedRoute;
      if (options.harness === undefined && options.model === undefined) {
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
      const prompt = await agent.resolvePrompt(options.prompt ?? task.prompt);
      await this.deps.stepRuns.setResolvedPrompt(rowId, mask(prompt));
      this.deps.onStepChanged?.(task.id);
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
          ...(state.session?.key === key ? { continueSessionId: state.session.id } : {}),
        });
        if (result.sessionId) state.session = { key, id: result.sessionId };
        output += result.output;
        if (!(await Git.isDirty(cwd))) break;
        if (turn >= nudges) return { outcome: 'fail', summary: UNCOMMITTED_AFTER_AGENT, stdout: mask(output), exitCode: null, output: mask(output) };
        text = options.continuePrompt ?? DEFAULT_CONTINUE_PROMPT;
      }
      return { outcome: 'pass', summary: `agent turn finished on ${route.harness}/${route.model}`, stdout: mask(output), exitCode: null, output: mask(output) };
    } catch (error) {
      return inconclusive(errorMessage(error));
    }
  }

  private async postMergeCheck(task: TaskRow, run: AttemptRow, step: WorkflowStepDefinition, env: Record<string, string>, secrets: string[]): Promise<StepResult> {
    const mask = (text: string): string => maskSecrets(text, secrets);
    const script = step.with?.run;
    if (typeof script !== 'string' || script === '') return { outcome: 'inconclusive', summary: 'post-merge-check needs with.run', stdout: '', exitCode: null, output: '' };
    const base = run.baseBranch ?? (await this.deps.baseBranchFor(task));
    const scratch = await mkdtemp(join(tmpdir(), 'harmonic-post-merge-'));
    const checkout = join(scratch, 'base');
    try {
      await Git.addDetachedWorktree(task.workingDir, checkout, base);
      const command: VerificationCommand = { id: step.id, command: 'sh', args: ['-c', script], env, timeoutSeconds: DEFAULT_RUN_TIMEOUT_SECONDS };
      const result = await this.deps.spawn.run({ command, cwd: checkout, timeoutMs: this.deps.runTimeoutMs ?? command.timeoutSeconds * 1000, outputCap: OUTPUT_CHAR_CAP });
      const verdict = exitCodeToVerdict(result);
      return { outcome: verdict.verdict, summary: mask(verdict.summary), stdout: mask(result.stdout), exitCode: result.code, output: mask(result.output) };
    } finally {
      await Git.removeWorktree(task.workingDir, checkout).catch(() => undefined);
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private async cleanup(task: TaskRow, run: AttemptRow): Promise<StepResult> {
    const done = (outcome: WorkflowStepOutcome, summary: string): StepResult => ({ outcome, summary, stdout: '', exitCode: null, output: '' });
    const worktree = this.deps.cwdFor(task);
    if (worktree === task.workingDir) return done('pass', 'the Ticket has no worktree to retire');
    const removed = await Git.removeWorktreeAndDeleteBranch(task.workingDir, worktree, run.branch, async () => true);
    return done('pass', removed ? `retired ${worktree}${run.branch ? ` and branch ${run.branch}` : ''}` : 'nothing to retire');
  }

  private async trackerAction(task: TaskRow, step: WorkflowStepDefinition): Promise<StepResult> {
    const done = (outcome: WorkflowStepOutcome, summary: string): StepResult => ({ outcome, summary, stdout: '', exitCode: null, output: '' });
    const text = typeof step.with?.body === 'string' ? step.with.body : '';
    if (step.uses === 'comment') {
      if (text === '') return done('inconclusive', 'comment needs with.body');
      if (!this.deps.commentOnTicket) return done('inconclusive', 'comment is not available');
      return (await this.deps.commentOnTicket(task, text)) ? done('pass', 'commented on the ticket') : done('inconclusive', 'the ticket could not be commented on: no tracker ticket or the tracker cannot comment');
    }
    if (!this.deps.closeTicket) return done('inconclusive', 'close-ticket is not available');
    if (task.trackerRef == null) return done('pass', 'the Task has no tracker ticket to close');
    return (await this.deps.closeTicket(task, text)) ? done('pass', 'closed the ticket') : done('fail', 'the tracker refused to close the ticket');
  }

  private async execute(task: TaskRow, run: AttemptRow, step: WorkflowStepDefinition, env: Record<string, string>, secrets: string[]): Promise<StepResult> {
    const mask = (text: string): string => maskSecrets(text, secrets);
    try {
      if (step.uses === 'rebase') return await this.rebase(task, mask);
      if (step.uses === 'post-merge-check') return await this.postMergeCheck(task, run, step, env, secrets);
      if (step.uses === 'cleanup') return await this.cleanup(task, run);
      if (step.uses === 'comment' || step.uses === 'close-ticket') return await this.trackerAction(task, step);
      if (step.uses === 'merge' || step.uses === 'open-pr' || step.uses === 'artifact') return await this.executeBranchAction(task, run, step.uses);
      if (step.run === undefined && step.uses !== 'command') {
        return { outcome: 'inconclusive', summary: 'action not yet supported', stdout: '', exitCode: null, output: '' };
      }
      const cwd = this.deps.cwdFor(task);
      let command: VerificationCommand;
      if (step.run !== undefined) {
        command = { id: step.id, command: 'sh', args: ['-c', step.run], env, timeoutSeconds: DEFAULT_RUN_TIMEOUT_SECONDS };
      } else {
        const id = step.with?.id;
        const found = typeof id === 'string' ? await this.deps.commandById(task, id) : undefined;
        if (!found) return { outcome: 'inconclusive', summary: `no configured verification command '${String(id)}'`, stdout: '', exitCode: null, output: '' };
        command = found;
      }
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
  const withValues =
    step.with &&
    Object.fromEntries(
      Object.entries(step.with).map(([key, value]) => [key, typeof value !== 'string' ? value : step.uses === 'post-merge-check' && key === 'run' ? toEnv(value) : interpolate(value, context)]),
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
