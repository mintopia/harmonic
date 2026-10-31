import { describe, expect, it } from 'vitest';
import { loadBaselineConfig, type WorkflowLabel, type WorkflowLabelOverlayEntry } from '../src/config.js';
import { resolveWorkflow, resolveTaskWorkflow } from '../src/domain/workflow-assignment.js';
import { workflowLabelIssues, workflowLabelOverlayIssues } from '../src/domain/setting-override.js';
import { resolveWorkflowLabels } from '../src/domain/workflow-labels.js';

const base = loadBaselineConfig();
const config = (labels: WorkflowLabel[] = [], workflow: string | null = null) => ({
  ...base,
  defaults: { ...base.defaults, workflow },
  workflowLabels: labels,
});
const ws = (workflow: string | null = null, overlay: WorkflowLabelOverlayEntry[] | null = null) => ({
  workflow,
  workflowLabels: overlay ? JSON.stringify(overlay) : null,
});

describe('resolveWorkflow precedence', () => {
  const cfg = config([{ label: 'bug', workflow: 'fix' }], 'global-wf');
  const workspace = ws('workspace-wf');

  it('explicit operator choice wins over everything', () => {
    expect(resolveWorkflow({ requested: 'mine', trackerLabels: ['bug'], workspace, config: cfg })).toEqual({ name: 'mine', chosen: 'explicit' });
  });
  it('a matching Workflow Label beats the Workspace and global defaults', () => {
    expect(resolveWorkflow({ requested: null, trackerLabels: ['bug'], workspace, config: cfg })).toEqual({ name: 'fix', chosen: 'label', label: 'bug' });
  });
  it('Workspace default beats the global default', () => {
    expect(resolveWorkflow({ requested: null, trackerLabels: ['other'], workspace, config: cfg })).toEqual({ name: 'workspace-wf', chosen: 'workspace' });
  });
  it('global default applies last', () => {
    expect(resolveWorkflow({ requested: null, trackerLabels: null, workspace: ws(), config: cfg })).toEqual({ name: 'global-wf', chosen: 'global' });
  });
  it('null when nothing applies', () => {
    expect(resolveWorkflow({ requested: null, trackerLabels: ['x'], workspace: null, config: config() })).toBeNull();
  });
  it('matches labels case-insensitively', () => {
    expect(resolveWorkflow({ requested: null, trackerLabels: ['BUG'], workspace: null, config: cfg })?.chosen).toBe('label');
  });
  it('skips a candidate whose workflow left the library and falls through', () => {
    const exists = (name: string) => name === 'global-wf';
    expect(resolveWorkflow({ requested: 'gone', trackerLabels: ['bug'], workspace, config: cfg, exists })).toEqual({ name: 'global-wf', chosen: 'global' });
  });
  it('only mirrored Tickets contribute tracker labels', () => {
    const native = { origin: 'native' as const, trackerLabels: ['bug'], workflowRequested: null };
    expect(resolveTaskWorkflow(native, null, cfg)).toEqual({ name: 'global-wf', chosen: 'global' });
    expect(resolveTaskWorkflow({ ...native, origin: 'mirrored' }, null, cfg)).toEqual({ name: 'fix', chosen: 'label', label: 'bug' });
  });
});

describe('first-match ordering', () => {
  it('list order wins, not Ticket label order', () => {
    const cfg = config([{ label: 'bug', workflow: 'first' }, { label: 'feature', workflow: 'second' }]);
    expect(resolveWorkflow({ requested: null, trackerLabels: ['feature', 'bug'], workspace: null, config: cfg })?.name).toBe('first');
  });
  it('a Workspace reorder changes the winner', () => {
    const cfg = config([{ label: 'bug', workflow: 'first' }, { label: 'feature', workflow: 'second' }]);
    const overlay: WorkflowLabelOverlayEntry[] = [{ kind: 'global', ref: 'feature', enabled: true }, { kind: 'global', ref: 'bug', enabled: true }];
    expect(resolveWorkflow({ requested: null, trackerLabels: ['bug', 'feature'], workspace: ws(null, overlay), config: cfg })?.name).toBe('second');
  });
});

describe('Workspace overlay', () => {
  const cfg = config([{ label: 'bug', workflow: 'fix' }]);
  it('a local label adds to the globals', () => {
    const overlay: WorkflowLabelOverlayEntry[] = [
      { kind: 'global', ref: 'bug', enabled: true },
      { kind: 'local', enabled: true, workflowLabel: { label: 'docs', workflow: 'write-docs' } },
    ];
    expect(resolveWorkflow({ requested: null, trackerLabels: ['docs'], workspace: ws(null, overlay), config: cfg })).toEqual({ name: 'write-docs', chosen: 'label', label: 'docs' });
    expect(resolveWorkflow({ requested: null, trackerLabels: ['bug'], workspace: ws(null, overlay), config: cfg })?.name).toBe('fix');
  });
  it('a global disabled in the Workspace is skipped', () => {
    const overlay: WorkflowLabelOverlayEntry[] = [{ kind: 'global', ref: 'bug', enabled: false }];
    expect(resolveWorkflow({ requested: null, trackerLabels: ['bug'], workspace: ws(null, overlay), config: cfg })).toBeNull();
  });
  it('a global added after customisation is appended', () => {
    expect(resolveWorkflowLabels(ws(null, []), cfg)).toEqual([{ label: 'bug', workflow: 'fix' }]);
  });
  it('a local label shadowed by an enabled global is dropped and flagged', () => {
    const overlay: WorkflowLabelOverlayEntry[] = [{ kind: 'local', enabled: true, workflowLabel: { label: 'BUG', workflow: 'other' } }];
    expect(resolveWorkflowLabels(ws(null, overlay), cfg)).toEqual([{ label: 'bug', workflow: 'fix' }]);
    expect(workflowLabelOverlayIssues(overlay, cfg.workflowLabels)).toEqual([{ index: 0, kind: 'duplicate-global', globalRef: 'bug' }]);
  });
  it('flags duplicate and blank global labels', () => {
    expect(workflowLabelIssues([{ label: 'a', workflow: 'x' }, { label: 'A ', workflow: 'y' }, { label: ' ', workflow: 'z' }])).toEqual([
      { index: 1, kind: 'duplicate' },
      { index: 2, kind: 'blank' },
    ]);
  });
});
