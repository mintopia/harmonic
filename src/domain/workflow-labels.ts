import type { WorkspaceRow } from '../db/schema.js';
import { workflowLabelOverrideSchema, type AppConfig, type WorkflowLabel, type WorkflowLabelOverlayEntry } from '../config.js';
import { isOverridable } from './settings-registry.js';
import { mergeLabelOverlay, workflowLabelOverlayIssues, workflowLabelIssueMessage } from './setting-override.js';
import type { WorkflowLibrary } from './workflow-library-store.js';
import type { WorkflowSubject } from './workflow.js';

export function parseWorkflowLabelOverlay(stored: string | null | undefined): WorkflowLabelOverlayEntry[] | null {
  return stored == null ? null : workflowLabelOverrideSchema.parse(JSON.parse(stored));
}

export function resolveWorkflowLabels(
  ws: Partial<Pick<WorkspaceRow, 'workflowLabels'>> | null | undefined,
  config: Pick<AppConfig, 'workflowLabels'>,
): WorkflowLabel[] {
  const overlay = parseWorkflowLabelOverlay(isOverridable('workflowLabels') ? ws?.workflowLabels : null);
  return mergeLabelOverlay<WorkflowLabel, WorkflowLabelOverlayEntry>(overlay, config.workflowLabels, (e) => e.ref, (e) => e.workflowLabel);
}

function missing(library: Pick<WorkflowLibrary, 'list'>, path: string, name: string, subject: WorkflowSubject = 'ticket'): string[] {
  const entry = library.list().find((e) => e.name === name);
  if (!entry) return [`${path}: workflow '${name}' is not in the Workflow Library`];
  if (entry.subject === subject) return [];
  return [subject === 'epic' ? `${path}: workflow '${name}' is not an Epic workflow` : `${path}: workflow '${name}' is an Epic workflow and cannot run Tickets`];
}

export function workflowReferenceProblems(
  library: Pick<WorkflowLibrary, 'list'>,
  input: { workflow?: string | null; epicWorkflow?: string | null; labels?: readonly WorkflowLabel[]; overlay?: readonly WorkflowLabelOverlayEntry[] | null; globals?: readonly WorkflowLabel[] },
): string[] {
  const problems: string[] = [];
  if (input.workflow != null) problems.push(...missing(library, 'workflow', input.workflow));
  if (input.epicWorkflow != null) problems.push(...missing(library, 'epicWorkflow', input.epicWorkflow, 'epic'));
  input.labels?.forEach((entry, i) => problems.push(...missing(library, `workflowLabels.${i}.workflow`, entry.workflow)));
  if (input.overlay) {
    for (const issue of workflowLabelOverlayIssues(input.overlay, input.globals ?? [])) {
      const entry = input.overlay[issue.index];
      problems.push(`workflowLabels.${issue.index}.workflowLabel.label: ${workflowLabelIssueMessage(issue, entry?.kind === 'local' ? entry.workflowLabel.label : '')}`);
    }
    input.overlay.forEach((entry, i) => {
      if (entry.kind === 'local') problems.push(...missing(library, `workflowLabels.${i}.workflowLabel.workflow`, entry.workflowLabel.workflow));
    });
  }
  return problems;
}
