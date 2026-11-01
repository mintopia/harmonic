import type { AppConfig } from '../config.js';
import type { WorkspaceRow } from '../db/schema.js';
import { parseWorkflowLabelOverlay } from './workflow-labels.js';

export interface WorkflowAssignment {
  kind: 'global-default' | 'workspace-default' | 'label';
  label?: string;
}

export function workflowAssignments(
  config: Pick<AppConfig, 'workflowLabels'> & { defaults: Pick<AppConfig['defaults'], 'workflow' | 'epicWorkflow'> },
  workspaces: readonly Pick<WorkspaceRow, 'name' | 'workflow' | 'epicWorkflow' | 'workflowLabels'>[],
): Map<string, WorkflowAssignment[]> {
  const byWorkflow = new Map<string, WorkflowAssignment[]>();
  const add = (workflow: string | null | undefined, assignment: WorkflowAssignment) => {
    if (!workflow) return;
    const list = byWorkflow.get(workflow) ?? [];
    if (!list.some((a) => a.kind === assignment.kind && a.label === assignment.label)) list.push(assignment);
    byWorkflow.set(workflow, list);
  };
  add(config.defaults.workflow, { kind: 'global-default' });
  add(config.defaults.epicWorkflow, { kind: 'global-default' });
  for (const entry of config.workflowLabels) add(entry.workflow, { kind: 'label', label: entry.label });
  for (const ws of workspaces) {
    add(ws.workflow, { kind: 'workspace-default', label: ws.name });
    add(ws.epicWorkflow, { kind: 'workspace-default', label: ws.name });
    for (const entry of parseWorkflowLabelOverlay(ws.workflowLabels) ?? []) {
      if (entry.kind === 'local') add(entry.workflowLabel.workflow, { kind: 'label', label: entry.workflowLabel.label });
    }
  }
  return byWorkflow;
}
