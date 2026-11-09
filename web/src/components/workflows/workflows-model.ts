import { ApiError } from '../../api';
import type { WorkflowIssue, WorkflowLibraryEntry } from '../../types';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function filterWorkflows(entries: readonly WorkflowLibraryEntry[], query: string): WorkflowLibraryEntry[] {
  const needle = query.trim().toLowerCase();
  return needle === '' ? [...entries] : entries.filter((e) => e.name.toLowerCase().includes(needle));
}

export function inUseText(inUse: { tickets: number; workspaces: number }): string {
  return `in use by ${plural(inUse.tickets, 'Ticket', 'Tickets')} / ${plural(inUse.workspaces, 'Workspace', 'Workspaces')}`;
}

export type ChipTone = 'neutral' | 'global' | 'workspace' | 'label';
export interface AssignedChip {
  tone: ChipTone;
  text: string;
}

export function assignedChips(entry: WorkflowLibraryEntry): AssignedChip[] {
  if (entry.assignedAs.length === 0) {
    return [{ tone: 'neutral', text: 'Not assigned' }];
  }
  return entry.assignedAs.map((a): AssignedChip => {
    if (a.kind === 'global-default') return { tone: 'global', text: 'Global default' };
    if (a.kind === 'workspace-default') return { tone: 'workspace', text: `Workspace default · ${a.label ?? ''}`.replace(/ · $/, '') };
    return { tone: 'label', text: `Workflow Label · ${a.label ?? ''}`.replace(/ · $/, '') };
  });
}

export function deleteBlock(entry: WorkflowLibraryEntry): string | null {
  const labels = entry.assignedAs.filter((a) => a.kind === 'label').length;
  const defaults = entry.assignedAs.length - labels;
  const parts = [
    entry.inUse.tickets > 0 ? plural(entry.inUse.tickets, 'Ticket', 'Tickets') : null,
    entry.inUse.workspaces > 0 ? plural(entry.inUse.workspaces, 'Workspace', 'Workspaces') : null,
    labels > 0 ? plural(labels, 'Workflow Label', 'Workflow Labels') : null,
    defaults > 0 ? plural(defaults, 'default', 'defaults') : null,
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : `In use by ${parts.join(' and ')}.`;
}

export function issuesOf(error: unknown): WorkflowIssue[] {
  return error instanceof ApiError ? error.issues : [];
}

export function issueText(issue: WorkflowIssue): string {
  return `Line ${issue.line}, col ${issue.column}: ${issue.message}`;
}

export function importRefusal(fileName: string, error: unknown): string {
  const first = issuesOf(error)[0];
  const reason = first ? issueText(first) : error instanceof Error ? error.message : String(error);
  return `Import refused: ${fileName}\n${reason}. Nothing was added to the library.`;
}

export interface EditorModel {
  saved: string;
  text: string;
  version: number;
  saving: boolean;
  issues: WorkflowIssue[];
}

export type EditorAction =
  | { type: 'edit'; text: string }
  | { type: 'saving' }
  | { type: 'refused'; issues: WorkflowIssue[] }
  | { type: 'failed' }
  | { type: 'saved'; text: string; version: number };

export function initialEditor(text: string, version: number): EditorModel {
  return { saved: text, text, version, saving: false, issues: [] };
}

export function editorReducer(state: EditorModel, action: EditorAction): EditorModel {
  switch (action.type) {
    case 'edit':
      return { ...state, text: action.text, issues: [] };
    case 'saving':
      return { ...state, saving: true };
    case 'refused':
      return { ...state, saving: false, issues: action.issues };
    case 'failed':
      return { ...state, saving: false };
    case 'saved':
      return { saved: action.text, text: action.text, version: action.version, saving: false, issues: [] };
  }
}

export type EditorStatusKind = 'saved' | 'edited' | 'saving' | 'errors';
export interface EditorStatus {
  status: EditorStatusKind;
  pill: string;
  saveLabel: string;
  saveDisabled: boolean;
}

export function editorStatus(state: EditorModel): EditorStatus {
  if (state.saving) return { status: 'saving', pill: 'Saving…', saveLabel: 'Saving…', saveDisabled: true };
  if (state.issues.length > 0) {
    const count = plural(state.issues.length, 'error', 'errors');
    return { status: 'errors', pill: count, saveLabel: `Save · ${count}`, saveDisabled: true };
  }
  if (state.text !== state.saved) return { status: 'edited', pill: 'Edited', saveLabel: `Save as v${state.version + 1}`, saveDisabled: false };
  return { status: 'saved', pill: 'Saved', saveLabel: 'Save', saveDisabled: true };
}
