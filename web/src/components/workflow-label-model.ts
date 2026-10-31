import type { AppConfig, WorkflowLabelOverlayEntry, WorkflowLibraryEntry } from '../types.js';
import { workflowLabelIssues, workflowLabelOverlayIssues, workflowLabelRef } from '../../../src/domain/setting-override.js';
import { firstIssueMessage } from './routing-label-overlay-model';
import { withMissingGlobals } from './verification-override-model';

type WorkflowLabel = AppConfig['workflowLabels'][number];

export const WORKFLOW_LABEL = 'Workflow Label';

export function versionSuffix(library: readonly WorkflowLibraryEntry[], name: string): string {
  const version = libraryVersion(library, name);
  return version !== null ? ` · v${version}` : ' (not in the Library)';
}


export function firstWorkflowLabelError(labels: readonly WorkflowLabel[]): string | null {
  return firstIssueMessage(workflowLabelIssues(labels), (index) => labels[index]?.label ?? '', WORKFLOW_LABEL);
}

export function workflowOverlayRows(overlay: readonly WorkflowLabelOverlayEntry[] | null, globals: readonly WorkflowLabel[]): WorkflowLabelOverlayEntry[] {
  return withMissingGlobals<WorkflowLabelOverlayEntry>(overlay, globals.map(workflowLabelRef));
}

export function newLocalWorkflowEntry(workflow: string): WorkflowLabelOverlayEntry {
  return { kind: 'local', enabled: true, workflowLabel: { label: '', workflow } };
}

export function firstWorkflowOverlayError(overlay: readonly WorkflowLabelOverlayEntry[] | null, globals: readonly WorkflowLabel[]): string | null {
  const rows = workflowOverlayRows(overlay, globals);
  return firstIssueMessage(
    workflowLabelOverlayIssues(rows, globals),
    (index) => {
      const row = rows[index];
      return row?.kind === 'local' ? row.workflowLabel.label : '';
    },
    WORKFLOW_LABEL,
  );
}

export const libraryVersion = (library: readonly WorkflowLibraryEntry[], name: string | null): number | null =>
  (name === null ? undefined : library.find((entry) => entry.name === name)?.version) ?? null;

export function workflowOptions(library: readonly WorkflowLibraryEntry[], current: string): string[] {
  const names = library.map((entry) => entry.name);
  return current !== '' && !names.includes(current) ? [...names, current] : names;
}
