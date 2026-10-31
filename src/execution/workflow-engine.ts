import { join } from 'node:path';
import type { AppConfig, VerificationCommand } from '../config.js';
import type { AttemptRow, TaskRow, WorkflowStepOutcome } from '../db/schema.js';
import type { WorkflowEntry } from '../domain/workflow-library-store.js';
import { agentStepWith, parseWorkflow, type WorkflowDefinition } from '../domain/workflow.js';
import { harnessConfig, resolveRoute, type ResolvedRoute } from '../domain/route.js';
import type { WorkflowStepOutputs, WorkflowStepRunStore } from '../domain/workflow-step-runs.js';
import { maskSecrets } from '../secrets/mask.js';
import { errorMessage } from '../error-handling.js';
import type { CriticHarnessDrive } from '../verification/critic.js';
import { exitCodeToVerdict, OUTPUT_CHAR_CAP, type CommandSpawn } from '../verification/command-verifier.js';
import type { MergeIntoBaseOutcome } from './branch-merge.js';
import { Git } from './git.js';

export const ONLY_THE_AGENT_COMMITS = 'only the agent commits';
export const UNCOMMITTED_AFTER_AGENT = 'uncommitted changes remain after the agent turn';
export const DEFAULT_CONTINUE_PROMPT = 'You have uncommitted changes in the worktree. Commit your work with a clear message, then stop.';
const DEFAULT_AGENT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_SECONDS = 600;
const ESCALATION_OUTPUT_CHARS = 4000;

export interface WorkflowEngineDeps {
  library: { getVersion(name: string, version: number): Promise<WorkflowEntry> };
  stepRuns: WorkflowStepRunStore;
  spawn: CommandSpawn;
  commandById: (task: TaskRow, id: string) => Promise<VerificationCommand | undefined>;
  secretValues: (task: TaskRow) => Promise<string[]>;
  cwdFor: (task: TaskRow) => string;
  baseBranchFor: (task: TaskRow) => Promise<string>;
  mergeBranch?: (task: TaskRow, run: AttemptRow) => Promise<MergeIntoBaseOutcome>;
  openPullRequest?: (task: TaskRow, run: AttemptRow) => Promise<string | null>;
  escalate: (task: TaskRow, run: AttemptRow, reason: string) => Promise<void>;
  complete: (task: TaskRow, run: AttemptRow) => Promise<void>;
  onStepChanged?: (taskId: number) => void;
  agent: {
    drive: CriticHarnessDrive;
    getConfig: () => Pick<AppConfig, 'harnesses'>;
    route: (task: TaskRow) => Promise<ResolvedRoute>;
    resolvePrompt: (text: string) => Promise<string>;
    timeoutMs?: number;
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

interface AgentRunState {
  route?: Promise<ResolvedRoute>;
  session?: { key: string; id: string };
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
    const passed = await this.deps.stepRuns.passedStepIds(task.id, ref);
    const secrets = await this.deps.secretValues(task);
    const agentState: AgentRunState = {};
    for (const [position, step] of workflow.steps.entries()) {
      if (passed.has(step.id)) continue;
      const action = step.run !== undefined ? 'run' : step.uses!;
      const row = await this.deps.stepRuns.start({ taskId: task.id, workflowRef: ref, stepId: step.id, position, action });
      this.deps.onStepChanged?.(task.id);
      const result = step.uses === 'agent' ? await this.executeAgent(task, step, row.id, secrets, agentState) : await this.execute(task, run, step, secrets);
      const outputs: WorkflowStepOutputs = { stdout: result.stdout, exitCode: result.exitCode, ...result.outputs };
      await this.deps.stepRuns.finish(row.id, { outcome: result.outcome, outputs, summary: result.summary });
      this.deps.onStepChanged?.(task.id);
      if (result.outcome !== 'pass') {
        if (result.outcome === 'conflict') await Git.abortRebase(this.deps.cwdFor(task));
        const tail = result.output.length > ESCALATION_OUTPUT_CHARS ? result.output.slice(-ESCALATION_OUTPUT_CHARS) : result.output;
        await this.deps.escalate(task, run, `workflow step ${step.id} ${result.outcome}: ${result.summary}${tail ? `\n${tail}` : ''}`);
        return;
      }
    }
    await this.deps.complete(task, run);
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

  private async executeAgent(task: TaskRow, step: WorkflowDefinition['steps'][number], rowId: number, secrets: string[], state: AgentRunState): Promise<StepResult> {
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

  private async execute(task: TaskRow, run: AttemptRow, step: WorkflowDefinition['steps'][number], secrets: string[]): Promise<StepResult> {
    const mask = (text: string): string => maskSecrets(text, secrets);
    try {
      if (step.uses === 'rebase') return await this.rebase(task, mask);
      if (step.uses === 'merge' || step.uses === 'open-pr' || step.uses === 'artifact') return await this.executeBranchAction(task, run, step.uses);
      if (step.run === undefined && step.uses !== 'command') {
        return { outcome: 'inconclusive', summary: 'action not yet supported', stdout: '', exitCode: null, output: '' };
      }
      const cwd = this.deps.cwdFor(task);
      let command: VerificationCommand;
      if (step.run !== undefined) {
        command = { id: step.id, command: 'sh', args: ['-c', step.run], env: {}, timeoutSeconds: DEFAULT_RUN_TIMEOUT_SECONDS };
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
