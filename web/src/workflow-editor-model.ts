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
  stale: boolean;
}

export function toEditorIssues(issues: readonly ErrorIssue[], source: WorkflowEditorIssue['source']): WorkflowEditorIssue[] {
  return issues.map((i) => ({ line: i.line, column: i.column, message: i.message, source }));
}

export function serverRefusalIssues(error: { message: string; issues?: readonly ErrorIssue[] }): WorkflowEditorIssue[] {
  return error.issues?.length ? toEditorIssues(error.issues, 'server') : [{ line: 1, column: 1, message: error.message, source: 'server' }];
}

export function validateWorkflowText(text: string, prev: WorkflowDiagramModel | null): WorkflowEditorValidation {
  try {
    return { issues: [], diagram: buildWorkflowDiagram(parseWorkflow(text)), stale: false };
  } catch (error) {
    const issues = (error as { issues?: ErrorIssue[] }).issues;
    const found = issues?.length ? toEditorIssues(issues, 'schema') : [{ line: 1, column: 1, message: error instanceof Error ? error.message : 'invalid workflow', source: 'schema' as const }];
    return { issues: found, diagram: prev, stale: prev !== null };
  }
}
