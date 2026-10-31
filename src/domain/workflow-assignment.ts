import type { AppConfig } from '../config.js';
import type { RawTaskRow, WorkflowChosen, WorkspaceRow } from '../db/schema.js';
import { resolveWorkflowLabels } from './workflow-labels.js';
import { workflowLabelRef } from './setting-override.js';

export type WorkflowAssignment = { name: string; chosen: WorkflowChosen; label?: string; reason?: string };

export interface ResolveWorkflowInput {
  requested: string | null;
  wayfinderType?: string | null;
  trackerLabels: readonly string[] | null;
  workspace: Partial<Pick<WorkspaceRow, 'workflow' | 'workflowLabels' | 'workflowClassifierEnabled'>> | null;
  config: Pick<AppConfig, 'defaults' | 'workflowLabels'>;
  /** A candidate naming a workflow the library no longer holds is skipped; omitted means every name exists. */
  exists?: (name: string) => boolean;
  /** The workflow classifier's pick, consulted only when no operator choice or Workflow Label decided. */
  classified?: { name: string; reason: string } | null;
}

/** The tiers above the classifier: an operator choice, a research Wayfinder Ticket, or a matching Workflow Label; null when none decided. */
export function resolveBeforeClassifier(input: ResolveWorkflowInput): WorkflowAssignment | null {
  const exists = input.exists ?? (() => true);
  if (input.requested != null && exists(input.requested)) return { name: input.requested, chosen: 'explicit' };
  if (input.wayfinderType === 'research' && exists('research')) return { name: 'research', chosen: 'global' };
  const have = new Set((input.trackerLabels ?? []).map((label) => workflowLabelRef({ label })));
  if (have.size > 0) {
    const match = resolveWorkflowLabels(input.workspace, input.config).find((entry) => have.has(workflowLabelRef(entry)) && exists(entry.workflow));
    if (match) return { name: match.workflow, chosen: 'label', label: match.label };
  }
  return null;
}

export function resolveWorkflow(input: ResolveWorkflowInput): WorkflowAssignment {
  const exists = input.exists ?? (() => true);
  const decided = resolveBeforeClassifier(input);
  if (decided) return decided;
  if (input.classified && exists(input.classified.name)) return { name: input.classified.name, chosen: 'classifier', reason: input.classified.reason };
  const workspaceDefault = input.workspace?.workflow ?? null;
  if (workspaceDefault != null && exists(workspaceDefault)) return { name: workspaceDefault, chosen: 'workspace' };
  const globalDefault = input.config.defaults.workflow;
  if (globalDefault != null && exists(globalDefault)) return { name: globalDefault, chosen: 'global' };
  return { name: 'implement', chosen: 'global' };
}

export type EpicWorkflowAssignment = { name: string; chosen: 'workspace' | 'global' };

export function resolveEpicWorkflow(
  workspace: Partial<Pick<WorkspaceRow, 'epicWorkflow'>> | null,
  config: Pick<AppConfig, 'defaults'>,
  exists: (name: string) => boolean = () => true,
): EpicWorkflowAssignment {
  const workspaceChoice = workspace?.epicWorkflow ?? null;
  if (workspaceChoice != null && exists(workspaceChoice)) return { name: workspaceChoice, chosen: 'workspace' };
  const globalChoice = config.defaults.epicWorkflow;
  if (globalChoice != null && exists(globalChoice)) return { name: globalChoice, chosen: 'global' };
  return { name: 'epic', chosen: 'global' };
}

export function workflowInputOf(
  task: Pick<RawTaskRow, 'origin' | 'trackerLabels' | 'workflowRequested' | 'wayfinderType'>,
  workspace: ResolveWorkflowInput['workspace'],
  config: ResolveWorkflowInput['config'],
  exists?: (name: string) => boolean,
  classified?: ResolveWorkflowInput['classified'],
): ResolveWorkflowInput {
  return {
    requested: task.workflowRequested,
    wayfinderType: task.wayfinderType,
    trackerLabels: task.origin === 'mirrored' ? task.trackerLabels : null,
    workspace,
    config,
    ...(exists ? { exists } : {}),
    ...(classified ? { classified } : {}),
  };
}

export function resolveTaskWorkflow(
  task: Pick<RawTaskRow, 'origin' | 'trackerLabels' | 'workflowRequested' | 'wayfinderType'>,
  workspace: ResolveWorkflowInput['workspace'],
  config: ResolveWorkflowInput['config'],
  exists?: (name: string) => boolean,
  classified?: ResolveWorkflowInput['classified'],
): WorkflowAssignment {
  return resolveWorkflow(workflowInputOf(task, workspace, config, exists, classified));
}
