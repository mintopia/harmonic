import type { WorkspaceRow } from '../db/schema.js';
import { DomainError } from '../domain/errors.js';
import type { UpdateWorkspaceInput } from '../domain/workspaces.js';
import type { AppConfig } from '../config.js';
import { workflowRunsOn } from '../domain/workflow.js';
import { resolveWorkflowLabels } from '../domain/workflow-labels.js';
import { resolveCodeRepository } from '../repository/resolve.js';
import { LOCAL_TARGET, type ExecutionTargetService } from './execution-targets.js';

export interface WorkspaceTargetState {
  codeRepository: string | null;
  isolationMode: 'direct' | 'worktree';
}

export function kubernetesTargetRefusal(target: string, state: WorkspaceTargetState): string | null {
  if (state.codeRepository === null) {
    return `Execution Target '${target}' needs a Code Repository: the remote is the base branch's source of truth. Add a Code Repository in Workspace settings first.`;
  }
  if (state.isolationMode === 'direct') {
    return `Execution Target '${target}' is not available to a Workspace in direct mode. Switch the Isolation Mode to worktree first.`;
  }
  return null;
}

export function normalizeTargetList(names: readonly string[]): string[] {
  return [...new Set(names.filter((name) => name !== LOCAL_TARGET))];
}

export async function workspaceTargetState(
  workspace: Pick<WorkspaceRow, 'workingDir' | 'codeRepository' | 'isolationMode'>,
  globalIsolationMode: 'direct' | 'worktree',
  resolveRepository: typeof resolveCodeRepository = resolveCodeRepository,
): Promise<WorkspaceTargetState> {
  return {
    codeRepository: await resolveRepository(workspace.workingDir, workspace.codeRepository),
    isolationMode: (workspace.isolationMode as 'direct' | 'worktree' | null) ?? globalIsolationMode,
  };
}

export interface AssertTargetsDeps {
  targets: Pick<ExecutionTargetService, 'find'>;
  globalIsolationMode: 'direct' | 'worktree';
  resolveRepository?: typeof resolveCodeRepository;
}

/** Normalizes `patch.executionTargets` in place. */
export async function assertWorkspaceExecutionTargets(current: WorkspaceRow, patch: UpdateWorkspaceInput, deps: AssertTargetsDeps): Promise<void> {
  if (patch.executionTargets) patch.executionTargets = normalizeTargetList(patch.executionTargets);
  const list = patch.executionTargets === undefined ? current.executionTargets : patch.executionTargets;
  const touchesState = patch.isolationMode !== undefined || patch.codeRepository !== undefined || patch.workingDir !== undefined;
  if (!list || list.length === 0 || (patch.executionTargets === undefined && !touchesState)) return;

  const after = {
    workingDir: patch.workingDir ?? current.workingDir,
    codeRepository: patch.codeRepository === undefined ? current.codeRepository : patch.codeRepository,
    isolationMode: patch.isolationMode === undefined ? current.isolationMode : patch.isolationMode,
  };
  const state = await workspaceTargetState(after, deps.globalIsolationMode, deps.resolveRepository);
  for (const name of list) {
    if (!(await deps.targets.find(name))) {
      if (patch.executionTargets !== undefined && !current.executionTargets?.includes(name)) throw new DomainError('validation', `executionTargets: unknown Execution Target '${name}'`);
      continue;
    }
    const refusal = kubernetesTargetRefusal(name, state);
    if (refusal) throw new DomainError('validation', `executionTargets: ${refusal}`);
  }
}

export interface WorkspaceTargetItem {
  name: string;
  builtIn: boolean;
  globallyEnabled: boolean;
  allowed: boolean;
  effective: boolean;
  ineffectiveReason: string | null;
  refusal: string | null;
}

export interface WorkspaceTargetsView {
  restricted: boolean;
  codeRepository: string | null;
  isolationMode: 'direct' | 'worktree';
  targets: WorkspaceTargetItem[];
}

export async function describeWorkspaceTargets(
  workspace: WorkspaceRow,
  targets: Pick<ExecutionTargetService, 'listWithLocal'>,
  globalIsolationMode: 'direct' | 'worktree',
  resolveRepository?: typeof resolveCodeRepository,
): Promise<WorkspaceTargetsView> {
  const state = await workspaceTargetState(workspace, globalIsolationMode, resolveRepository);
  const list = workspace.executionTargets;
  const items = (await targets.listWithLocal()).map((target): WorkspaceTargetItem => {
    const allowed = target.builtIn || list === null || list.includes(target.name);
    const refusal = target.builtIn ? null : kubernetesTargetRefusal(target.name, state);
    const ineffectiveReason = !allowed ? null : !target.enabled ? 'Disabled globally; it has no effect until it is enabled.' : refusal;
    return { name: target.name, builtIn: target.builtIn, globallyEnabled: target.enabled, allowed, effective: allowed && ineffectiveReason === null, ineffectiveReason, refusal };
  });
  return { restricted: list !== null, codeRepository: state.codeRepository, isolationMode: state.isolationMode, targets: items };
}

type WorkflowUse = Pick<WorkspaceRow, 'workflow' | 'workflowLabels'>;
type IsolationUse = Pick<WorkspaceRow, 'isolationMode'>;
type GuardConfig = Pick<AppConfig, 'defaults'> & { workflowLabels: readonly AppConfig['workflowLabels'][number][] };

/** The workflows a Workspace runs by default or through a Workflow Label. */
export function workspaceWorkflowNames(ws: WorkflowUse, config: GuardConfig): string[] {
  const names = [ws.workflow ?? config.defaults.workflow, ...resolveWorkflowLabels(ws, { workflowLabels: [...config.workflowLabels] }).map((entry) => entry.workflow)];
  return [...new Set(names.filter((name): name is string => name != null))];
}

/** Names of `direct`-mode Workspaces that would run workflow `name` as their default or through a Workflow Label. */
export function directWorkspacesUsing(name: string, workspaces: readonly (WorkflowUse & IsolationUse & Pick<WorkspaceRow, 'name'>)[], config: GuardConfig): string[] {
  return workspaces
    .filter((ws) => (ws.isolationMode ?? config.defaults.isolationMode) === 'direct' && workspaceWorkflowNames(ws, config).includes(name))
    .map((ws) => ws.name);
}

export type WorkflowTexts = { list(): readonly { name: string; text: string }[] };

/** The first non-`local` target a workflow's `runs_on:` names; undefined when it runs only locally or is unknown. */
export function kubernetesTargetOf(library: WorkflowTexts, workflow: string): string | undefined {
  const entry = library.list().find((e) => e.name === workflow);
  return entry === undefined ? undefined : runsOnCached(entry.text).find((name) => name !== LOCAL_TARGET);
}

const RUNS_ON_CACHE_LIMIT = 256;
const runsOnCache = new Map<string, string[]>();

function runsOnCached(text: string): string[] {
  const hit = runsOnCache.get(text);
  if (hit) return hit;
  if (runsOnCache.size >= RUNS_ON_CACHE_LIMIT) runsOnCache.clear();
  const parsed = workflowRunsOn(text);
  runsOnCache.set(text, parsed);
  return parsed;
}

/** The refusal for running a Kubernetes workflow in `direct` mode; null when allowed. */
export function kubernetesWorkflowRefusal(library: WorkflowTexts, workflow: string, isolationMode: 'direct' | 'worktree'): string | null {
  const target = isolationMode === 'direct' ? kubernetesTargetOf(library, workflow) : undefined;
  if (target === undefined) return null;
  return `Workflow '${workflow}' runs on Kubernetes Execution Target '${target}', which is not available to a Ticket in direct mode. Switch the Isolation Mode to worktree first.`;
}

/** The refusal for a Workspace in `direct` mode whose default or Workflow Label workflow runs on Kubernetes; null when allowed. */
export function directWorkspaceRefusal(library: WorkflowTexts, ws: WorkflowUse & IsolationUse & Pick<WorkspaceRow, 'name'>, config: GuardConfig): string | null {
  if ((ws.isolationMode ?? config.defaults.isolationMode) !== 'direct') return null;
  for (const workflow of workspaceWorkflowNames(ws, config)) {
    const target = kubernetesTargetOf(library, workflow);
    if (target !== undefined) return `Workflow '${workflow}' runs on Kubernetes Execution Target '${target}', which is not available to Workspace '${ws.name}' in direct mode: it is the Workspace's default workflow or a Workflow Label's. Switch the Isolation Mode to worktree first.`;
  }
  return null;
}
