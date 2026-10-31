import type { WorkspaceRow } from '../db/schema.js';
import { workflowLabelOverrideSchema, type AppConfig, type WorkflowLabel, type WorkflowLabelOverlayEntry } from '../config.js';
import { isOverridable } from './settings-registry.js';
import { mergeLabelOverlay, workflowLabelOverlayIssues, workflowLabelIssueMessage } from './setting-override.js';
import type { WorkflowLibrary } from './workflow-library-store.js';

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

function missing(library: Pick<WorkflowLibrary, 'list'>, path: string, name: string): string[] {
  return library.list().some((entry) => entry.name === name) ? [] : [`${path}: workflow '${name}' is not in the Workflow Library`];
}

export function workflowReferenceProblems(
  library: Pick<WorkflowLibrary, 'list'>,
  input: { workflow?: string | null; labels?: readonly WorkflowLabel[]; overlay?: readonly WorkflowLabelOverlayEntry[] | null; globals?: readonly WorkflowLabel[] },
): string[] {
  const problems: string[] = [];
  if (input.workflow != null) problems.push(...missing(library, 'workflow', input.workflow));
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
