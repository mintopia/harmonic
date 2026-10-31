import type { TrackerRef } from './adapter.js';
import type { AppConfig } from '../config.js';
import { isEpicAttempt, type EpicAttemptRow, type WorkspaceRow } from '../db/schema.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { EnginePrompts } from '../domain/bundled-prompts.js';
import { resolveModelOption } from '../domain/model-options.js';
import type { ResolvedRoute } from '../domain/route.js';
import { resolveEpicWorkflow } from '../domain/workflow-assignment.js';
import type { WorkflowEntry } from '../domain/workflow-library-store.js';
import type { StepRunOwner, WorkflowStepRunStore } from '../domain/workflow-step-runs.js';
import type { MergeIntoBaseOutcome } from '../execution/branch-merge.js';
import type { EpicRunWorkflow, EpicWorkflowOutcome } from '../execution/epic-coordinator.js';
import type { EpicWorktreePool } from '../execution/epic-worktree-pool.js';
import { WorkflowEngine, type AgentDrive, type EpicSubject, type WorkflowEngineDeps } from '../execution/workflow-engine.js';
import { logger } from '../logger.js';
import type { CommandSpawn } from '../verification/command-verifier.js';
import type { MergeEpicIntegration } from './epic-service.js';

export type EpicWorkflowInput = Parameters<EpicRunWorkflow>[0];

export interface EpicWorkflowRunnerDeps {
  workspace: WorkspaceRow;
  getWorkspaces: () => Promise<WorkspaceRow[]>;
  getConfig: () => Pick<AppConfig, 'defaults' | 'harnesses' | 'modelOptions'>;
  library: { list(): WorkflowEntry[]; get(name: string): WorkflowEntry; getVersion(name: string, version: number): Promise<WorkflowEntry> };
  stepRuns: WorkflowStepRunStore;
  epicAttempts: AttemptStore;
  worktrees: EpicWorktreePool;
  mergeEpicIntegration: MergeEpicIntegration;
  commandSpawn: CommandSpawn;
  secrets?: { list(workspaceId: number): Promise<{ name: string }[]>; reveal(workspaceId: number, name: string): Promise<string | null> } | undefined;
  workflowRefs: { get(workspaceId: number, epicRef: TrackerRef): Promise<string | null>; set(workspaceId: number, epicRef: TrackerRef, ref: string): Promise<void> };
  tracker: { close(epicRef: TrackerRef, comment: string | undefined): Promise<boolean>; comment(epicRef: TrackerRef, body: string): Promise<boolean> };
  agent: {
    drive: AgentDrive<EpicSubject>;
    prompts: () => EnginePrompts;
    route: (workspaceId: number, epicRef: TrackerRef) => Promise<ResolvedRoute>;
    resolvePrompt: (text: string) => Promise<string>;
  };
  onStepChanged?: ((owner: StepRunOwner) => void) | undefined;
  onEpicAttemptChanged?: ((attempt: EpicAttemptRow) => void) | undefined;
}

interface RunState {
  input: EpicWorkflowInput;
  cwd: string;
  mergeOid: string | null;
  outcome?: EpicWorkflowOutcome;
}

export class EpicWorkflowRunner {
  private readonly runs = new Map<TrackerRef, RunState>();

  private readonly engine: WorkflowEngine<EpicSubject>;

  constructor(private readonly deps: EpicWorkflowRunnerDeps) {
    this.engine = new WorkflowEngine<EpicSubject>(this.engineDeps());
  }

  async run(input: EpicWorkflowInput): Promise<EpicWorkflowOutcome> {
    const { workspace, epicAttempts, worktrees } = this.deps;
    const { epicRef } = input;
    const stored = await this.deps.workflowRefs.get(workspace.id, epicRef);
    const leftover = await epicAttempts.getRunningForEpic({ workspaceId: workspace.id, epicRef });
    const resumed = leftover !== undefined && stored !== null && input.guidance === undefined;
    const workflowRef = resumed ? stored : await this.pin(epicRef);
    const created = await epicAttempts.createForEpic({ workspaceId: workspace.id, epicRef });
    const attempt = (await epicAttempts.update(created.id, {
      branch: input.integrationBranch,
      baseBranch: input.defaultBranch,
      ...(input.guidance !== undefined ? { feedback: input.guidance } : {}),
    })) as EpicAttemptRow;
    this.publish(attempt);
    const state: RunState = { input, cwd: await worktrees.acquire(input.repoDir, epicRef), mergeOid: null };
    this.runs.set(epicRef, state);
    try {
      await this.engine.run(this.subject(input, workflowRef), attempt, resumed, input.continuation !== 'fresh');
      if (state.outcome === undefined) await this.settle(attempt, input, 'escalated', 'the workflow ended without completing', state);
      return state.outcome!;
    } catch (error) {
      await this.settle(attempt, input, 'escalated', error instanceof Error ? error.message : String(error), state).catch((err: unknown) => {
        logger.warn('epic attempt settle failed', { epicRef, error: err instanceof Error ? err.message : String(err) });
      });
      throw error;
    } finally {
      this.runs.delete(epicRef);
      await worktrees.release(workspace.workingDir, epicRef);
    }
  }

  private async pin(epicRef: TrackerRef): Promise<string> {
    const { workspace, library } = this.deps;
    const live = (await this.deps.getWorkspaces()).find((candidate) => candidate.id === workspace.id) ?? workspace;
    const usable = new Set(library.list().filter((entry) => entry.subject === 'epic').map((entry) => entry.name));
    const { name } = resolveEpicWorkflow(live, this.deps.getConfig(), (candidate) => usable.has(candidate));
    const ref = `${name}@${library.get(name).version}`;
    await this.deps.workflowRefs.set(workspace.id, epicRef, ref);
    return ref;
  }

  private subject(input: EpicWorkflowInput, workflowRef: string): EpicSubject {
    return {
      epicRef: input.epicRef,
      workspaceId: this.deps.workspace.id,
      workflowRef,
      workflowVars: null,
      prompt: `Integrate Epic #${input.epicRef}`,
      feedback: input.guidance ?? null,
      trackerTitle: input.title ?? `Epic #${input.epicRef}`,
      trackerBody: input.body ?? '',
      trackerLabels: [],
      trackerRef: input.epicRef,
      origin: 'mirrored',
      workingDir: this.deps.workspace.workingDir,
    };
  }

  private publish(attempt: EpicAttemptRow): void {
    if (isEpicAttempt(attempt)) this.deps.onEpicAttemptChanged?.(attempt);
  }

  private async settle(attempt: { id: number }, input: EpicWorkflowInput, state: 'passed' | 'escalated', detail: string, run: RunState): Promise<void> {
    const row = await this.deps.epicAttempts.updateWithFrozenCost(attempt.id, { state, reason: 'epic-verification', detail, endedAt: Date.now(), verifiedHeadOid: input.verifiedHeadOid });
    this.publish(row as EpicAttemptRow);
    if (state === 'escalated') run.outcome = { kind: 'escalated', reason: detail };
  }

  private stateOf(task: EpicSubject): RunState {
    const state = this.runs.get(task.epicRef);
    if (!state) throw new Error(`Epic #${task.epicRef} has no run in progress`);
    return state;
  }

  private engineDeps(): WorkflowEngineDeps<EpicSubject> {
    const { deps } = this;
    return {
      library: deps.library,
      stepRuns: deps.stepRuns,
      spawn: deps.commandSpawn,
      secrets: async (task) => {
        if (!deps.secrets) return {};
        const secrets = deps.secrets;
        const entries = await Promise.all((await secrets.list(task.workspaceId)).map(async (secret) => [secret.name, await secrets.reveal(task.workspaceId, secret.name)] as const));
        return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null));
      },
      workspaceName: async () => deps.workspace.name,
      cwdFor: (task) => this.stateOf(task).cwd,
      baseBranchFor: async (task) => this.stateOf(task).input.defaultBranch,
      mergeBranch: async (task, run): Promise<MergeIntoBaseOutcome> => {
        const state = this.stateOf(task);
        state.input.onPhase?.('merging');
        const merged = await deps.mergeEpicIntegration({
          workspaceId: deps.workspace.id,
          repoDir: state.input.repoDir,
          epicRef: task.epicRef,
          defaultBranch: run.baseBranch!,
          integrationBranch: run.branch!,
          runPostMergeCheck: async () => ({ pass: true, output: '' }),
        });
        if (merged.kind === 'merged') {
          state.mergeOid = merged.mergeOid;
          return { ok: true, mode: 'cas', oid: merged.mergeOid, baseBranch: run.baseBranch!, branch: run.branch! };
        }
        return { ok: false, reason: merged.reason === 'conflict' ? 'conflict' : 'stale-base', detail: `${merged.reason}: ${merged.message}` };
      },
      closeTicket: (task, comment) => deps.tracker.close(task.epicRef, comment),
      commentOnTicket: (task, body) => deps.tracker.comment(task.epicRef, body),
      escalate: async (task, run, reason) => {
        const state = this.stateOf(task);
        await this.settle(run, state.input, 'escalated', reason, state);
      },
      complete: async (task, run) => {
        const state = this.stateOf(task);
        await this.settle(run, state.input, 'passed', 'integrated', state);
        state.outcome = { kind: 'integrated', mergeOid: state.mergeOid };
      },
      onStepChanged: (owner) => deps.onStepChanged?.(owner),
      agent: {
        drive: deps.agent.drive,
        getConfig: deps.getConfig,
        prompts: deps.agent.prompts,
        route: (task) => deps.agent.route(task.workspaceId, task.epicRef),
        resolveOption: async (task, code) => {
          const live = (await deps.getWorkspaces()).find((candidate) => candidate.id === task.workspaceId) ?? deps.workspace;
          return resolveModelOption(code, { workspace: { modelOptions: live.modelOptions }, config: deps.getConfig() });
        },
        resolvePrompt: deps.agent.resolvePrompt,
        promptFields: async (task) => {
          const { input } = this.stateOf(task);
          return { taskId: '', skill: '', ref: String(task.epicRef), url: input.url ?? '', title: `Epic #${task.epicRef}`, description: input.body ?? '', branch: input.integrationBranch };
        },
        healFields: (task, heal) => ({
          reason: `${heal.output || heal.reason}${task.feedback ? `\n\n## Operator guidance\n${task.feedback}` : ''}`,
          output: '',
        }),
      },
    };
  }
}
