import type { ErrorIssue } from '../../src/domain/errors.js';
import { parseWorkflow } from '../../src/domain/workflow.js';
import { buildWorkflowDiagram, type WorkflowDiagramModel } from '../../src/domain/workflow-diagram.js';

export interface WorkflowEditorIssue {
  line: number;
  column: number;
  message: string;
  source: 'schema' | 'server';
}

export interface WorkflowEditorValidation {
  issues: WorkflowEditorIssue[];
  diagram: WorkflowDiagramModel | null;
}

export function toEditorIssues(issues: readonly ErrorIssue[], source: WorkflowEditorIssue['source']): WorkflowEditorIssue[] {
  return issues.map((i) => ({ line: i.line, column: i.column, message: i.message, source }));
}

export function validateWorkflowText(text: string): WorkflowEditorValidation {
  try {
    return { issues: [], diagram: buildWorkflowDiagram(parseWorkflow(text)) };
  } catch (error) {
    const issues = (error as { issues?: ErrorIssue[] }).issues;
    const found = issues?.length ? toEditorIssues(issues, 'schema') : [{ line: 1, column: 1, message: error instanceof Error ? error.message : 'invalid workflow', source: 'schema' as const }];
    return { issues: found, diagram: null };
  }
}

export interface MessagePart { text: string; code: boolean }

export function messageParts(message: string): MessagePart[] {
  const m = /^unknown key: (\S+?)(?: \(did you mean (\S+?)\?\))?$/.exec(message);
  if (!m) return [{ text: message, code: false }];
  const parts: MessagePart[] = [{ text: 'unknown key: ', code: false }, { text: m[1]!, code: true }];
  if (m[2] !== undefined) parts.push({ text: ' (did you mean ', code: false }, { text: m[2], code: true }, { text: '?)', code: false });
  return parts;
}
