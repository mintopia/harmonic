import type { WorkspaceRow } from '../db/schema.js';
import { DomainError } from '../domain/errors.js';
import type { UpdateWorkspaceInput } from '../domain/workspaces.js';
import type { AppConfig } from '../config.js';
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

/** Names of `direct`-mode Workspaces that would run workflow `name` as their default or through a Workflow Label. */
export function directWorkspacesUsing(
  name: string,
  workspaces: readonly Pick<WorkspaceRow, 'name' | 'isolationMode' | 'workflow' | 'workflowLabels'>[],
  config: Pick<AppConfig, 'defaults' | 'workflowLabels'>,
): string[] {
  return workspaces
    .filter((ws) => (ws.isolationMode ?? config.defaults.isolationMode) === 'direct')
    .filter((ws) => (ws.workflow ?? config.defaults.workflow) === name || resolveWorkflowLabels(ws, config).some((entry) => entry.workflow === name))
    .map((ws) => ws.name);
}

/** The refusal for assigning a Kubernetes workflow to a Ticket that runs in `direct` mode; null when allowed. */
export async function kubernetesWorkflowRefusal(
  workflow: string,
  runsOn: readonly string[],
  isolationMode: string,
  targets: Pick<ExecutionTargetService, 'find'>,
): Promise<string | null> {
  if (isolationMode !== 'direct') return null;
  for (const target of runsOn) {
    if (await targets.find(target)) return `Workflow '${workflow}' runs on Kubernetes Execution Target '${target}', which is not available to a Ticket in direct mode. Switch the Isolation Mode to worktree first.`;
  }
  return null;
}
