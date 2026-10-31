import type { AppConfig } from '../config.js';
import type { RawTaskRow, WorkflowChosen, WorkspaceRow } from '../db/schema.js';
import { resolveWorkflowLabels } from './workflow-labels.js';
import { workflowLabelRef } from './setting-override.js';

export type WorkflowAssignment = { name: string; chosen: WorkflowChosen; label?: string };

export interface ResolveWorkflowInput {
  requested: string | null;
  trackerLabels: readonly string[] | null;
  workspace: Partial<Pick<WorkspaceRow, 'workflow' | 'workflowLabels'>> | null;
  config: Pick<AppConfig, 'defaults' | 'workflowLabels'>;
  /** A candidate naming a workflow the library no longer holds is skipped; omitted means every name exists. */
  exists?: (name: string) => boolean;
}

export function resolveWorkflow(input: ResolveWorkflowInput): WorkflowAssignment | null {
  const exists = input.exists ?? (() => true);
  if (input.requested != null && exists(input.requested)) return { name: input.requested, chosen: 'explicit' };
  const have = new Set((input.trackerLabels ?? []).map((label) => workflowLabelRef({ label })));
  if (have.size > 0) {
    const match = resolveWorkflowLabels(input.workspace, input.config).find((entry) => have.has(workflowLabelRef(entry)) && exists(entry.workflow));
    if (match) return { name: match.workflow, chosen: 'label', label: match.label };
  }
  const workspaceDefault = input.workspace?.workflow ?? null;
  if (workspaceDefault != null && exists(workspaceDefault)) return { name: workspaceDefault, chosen: 'workspace' };
  const globalDefault = input.config.defaults.workflow;
  if (globalDefault != null && exists(globalDefault)) return { name: globalDefault, chosen: 'global' };
  return null;
}

export function resolveTaskWorkflow(
  task: Pick<RawTaskRow, 'origin' | 'trackerLabels' | 'workflowRequested'>,
  workspace: ResolveWorkflowInput['workspace'],
  config: ResolveWorkflowInput['config'],
  exists?: (name: string) => boolean,
): WorkflowAssignment | null {
  return resolveWorkflow({
    requested: task.workflowRequested,
    trackerLabels: task.origin === 'mirrored' ? task.trackerLabels : null,
    workspace,
    config,
    ...(exists ? { exists } : {}),
  });
}
