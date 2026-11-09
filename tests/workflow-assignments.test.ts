import { describe, expect, it } from 'vitest';
import { workflowAssignments } from '../src/domain/workflow-assignments.js';
import { deleteBlock } from '../web/src/components/workflows/workflows-model';
import type { WorkflowLibraryEntry } from '../web/src/types';

const config = { defaults: { workflow: 'implement', epicWorkflow: 'epic-run' }, workflowLabels: [{ label: 'bug', workflow: 'fix' }] };

describe('workflowAssignments', () => {
  it('maps global defaults, Workspace defaults and Workflow Labels to workflow names', () => {
    const workspaces = [
      { name: 'api', workflow: 'fix', epicWorkflow: null, workflowLabels: JSON.stringify([{ kind: 'local', enabled: true, workflowLabel: { label: 'docs', workflow: 'docs-only' } }, { kind: 'global', ref: 'bug', enabled: true }]) },
    ];
    const map = workflowAssignments(config, workspaces);
    expect(map.get('implement')).toEqual([{ kind: 'global-default' }]);
    expect(map.get('epic-run')).toEqual([{ kind: 'global-default' }]);
    expect(map.get('fix')).toEqual([{ kind: 'label', label: 'bug' }, { kind: 'workspace-default', label: 'api' }]);
    expect(map.get('docs-only')).toEqual([{ kind: 'label', label: 'docs' }]);
    expect(map.get('unused')).toBeUndefined();
  });
});

describe('deleteBlock', () => {
  const entry = (assignedAs: WorkflowLibraryEntry['assignedAs']): WorkflowLibraryEntry =>
    ({ name: 'x', inUse: { tickets: 0, running: 0, workspaces: 0 }, assignedAs }) as WorkflowLibraryEntry;
  it('names labels and defaults separately and allows unused workflows', () => {
    expect(deleteBlock(entry([]))).toBeNull();
    expect(deleteBlock(entry([{ kind: 'label', label: 'docs' }, { kind: 'global-default' }]))).toBe('In use by 1 Workflow Label and 1 default.');
  });
});
