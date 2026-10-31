import { join } from 'node:path';
import type { VerificationCommand } from '../config.js';
import type { AttemptRow, TaskRow, WorkflowStepOutcome } from '../db/schema.js';
import type { WorkflowEntry } from '../domain/workflow-library-store.js';
import { parseWorkflow, type WorkflowDefinition } from '../domain/workflow.js';
import type { WorkflowStepOutputs, WorkflowStepRunStore } from '../domain/workflow-step-runs.js';
import { maskSecrets } from '../secrets/mask.js';
import { errorMessage } from '../error-handling.js';
import { exitCodeToVerdict, OUTPUT_CHAR_CAP, type CommandSpawn } from '../verification/command-verifier.js';
import type { MergeIntoBaseOutcome } from './branch-merge.js';
import { Git } from './git.js';

export const ONLY_THE_AGENT_COMMITS = 'only the agent commits';
const DEFAULT_RUN_TIMEOUT_SECONDS = 600;
const ESCALATION_OUTPUT_CHARS = 4000;

export interface WorkflowEngineDeps {
  library: { getVersion(name: string, version: number): Promise<WorkflowEntry> };
  stepRuns: WorkflowStepRunStore;
  spawn: CommandSpawn;
  commandById: (task: TaskRow, id: string) => Promise<VerificationCommand | undefined>;
  secretValues: (task: TaskRow) => Promise<string[]>;
  cwdFor: (task: TaskRow) => string;
  mergeBranch?: (task: TaskRow, run: AttemptRow) => Promise<MergeIntoBaseOutcome>;
  openPullRequest?: (task: TaskRow, run: AttemptRow) => Promise<string | null>;
  escalate: (task: TaskRow, run: AttemptRow, reason: string) => Promise<void>;
  complete: (task: TaskRow, run: AttemptRow) => Promise<void>;
  onStepChanged?: (taskId: number) => void;
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
    for (const [position, step] of workflow.steps.entries()) {
      if (passed.has(step.id)) continue;
      const action = step.run !== undefined ? 'run' : step.uses!;
      const row = await this.deps.stepRuns.start({ taskId: task.id, workflowRef: ref, stepId: step.id, position, action });
      this.deps.onStepChanged?.(task.id);
      const result = await this.execute(task, run, step, secrets);
      const outputs: WorkflowStepOutputs = { stdout: result.stdout, exitCode: result.exitCode, ...result.outputs };
      await this.deps.stepRuns.finish(row.id, { outcome: result.outcome, outputs, summary: result.summary });
      this.deps.onStepChanged?.(task.id);
      if (result.outcome !== 'pass') {
        const tail = result.output.length > ESCALATION_OUTPUT_CHARS ? result.output.slice(-ESCALATION_OUTPUT_CHARS) : result.output;
        await this.deps.escalate(task, run, `workflow step ${step.id} ${result.outcome}: ${result.summary}${tail ? `\n${tail}` : ''}`);
        return;
      }
    }
    await this.deps.complete(task, run);
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

  private async execute(task: TaskRow, run: AttemptRow, step: WorkflowDefinition['steps'][number], secrets: string[]): Promise<StepResult> {
    const mask = (text: string): string => maskSecrets(text, secrets);
    try {
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
