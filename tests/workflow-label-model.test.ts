import { describe, expect, it } from 'vitest';
import {
  firstWorkflowLabelError,
  firstWorkflowOverlayError,
  libraryVersion,
  newLocalWorkflowEntry,
  workflowOptions,
  workflowOverlayRows,
} from '../web/src/components/workflow-label-model.js';
import { newerVersion, parseWorkflowRef, snapshotNote } from '../web/src/workflow-ref-model.js';
import type { WorkflowLabelOverlayEntry } from '../web/src/types.js';

const globals = [
  { label: 'Security', workflow: 'review' },
  { label: 'docs', workflow: 'docs-only' },
];
const local = (label: string, enabled = true): WorkflowLabelOverlayEntry => ({ kind: 'local', enabled, workflowLabel: { label, workflow: 'w' } });

describe('workflowOverlayRows', () => {
  it('inherits every global, lowercased and enabled, when the overlay is null', () => {
    expect(workflowOverlayRows(null, globals)).toEqual([
      { kind: 'global', ref: 'security', enabled: true },
      { kind: 'global', ref: 'docs', enabled: true },
    ]);
  });

  it('appends a global the overlay does not name', () => {
    const rows = workflowOverlayRows([local('x'), { kind: 'global', ref: 'docs', enabled: false }], globals);
    expect(rows.map((r) => (r.kind === 'global' ? r.ref : r.workflowLabel.label))).toEqual(['x', 'docs', 'security']);
  });
});

describe('workflow label errors', () => {
  it('names the first blank or duplicate global label', () => {
    expect(firstWorkflowLabelError(globals)).toBeNull();
    expect(firstWorkflowLabelError([{ label: ' ', workflow: 'a' }])).toMatch(/^Workflow Label 1: /);
    expect(firstWorkflowLabelError([...globals, { label: 'DOCS', workflow: 'a' }])).toMatch(/^Workflow Label 3: /);
  });

  it('flags a local row shadowing an enabled global, until the global is disabled', () => {
    expect(firstWorkflowOverlayError(null, globals)).toBeNull();
    expect(firstWorkflowOverlayError([local('Security')], globals)).toMatch(/^Workflow Label 1: .*security/);
    expect(firstWorkflowOverlayError([local('Security'), { kind: 'global', ref: 'security', enabled: false }], globals)).toBeNull();
  });
});

describe('library helpers', () => {
  const library = [{ name: 'review', description: '', subject: 'ticket' as const, version: 4, inUse: { tickets: 0, running: 0, workspaces: 0 }, assignedAs: [] }];

  it('adds a blank enabled local entry', () => {
    expect(newLocalWorkflowEntry('review')).toEqual({ kind: 'local', enabled: true, workflowLabel: { label: '', workflow: 'review' } });
  });

  it('reads versions and keeps a workflow that left the Library selectable', () => {
    expect(libraryVersion(library, 'review')).toBe(4);
    expect(libraryVersion(library, 'gone')).toBeNull();
    expect(libraryVersion(library, null)).toBeNull();
    expect(workflowOptions(library, 'gone')).toEqual(['review', 'gone']);
    expect(workflowOptions(library, '')).toEqual(['review']);
  });
});

describe('workflow ref model', () => {
  it('parses name and version', () => {
    expect(parseWorkflowRef('Security review@4')).toEqual({ name: 'Security review', version: 4 });
    expect(parseWorkflowRef('plain')).toEqual({ name: 'plain', version: null });
  });

  it('notes a newer Library version only', () => {
    expect(newerVersion('a@4', 5)).toBe(5);
    expect(newerVersion('a@4', 4)).toBeNull();
    expect(newerVersion('a@4', null)).toBeNull();
    expect(snapshotNote('a@4', 5)).toBe('Snapshotted v4; v5 exists and applies from the next Retry.');
    expect(snapshotNote('a@4', 4)).toBeNull();
  });
});
