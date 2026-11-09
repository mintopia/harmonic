import { describe, expect, it } from 'vitest';
import { ApiError } from '../web/src/api.js';
import type { WorkflowLibraryEntry } from '../web/src/types.js';
import {
  assignedChips,
  deleteBlock,
  editorReducer,
  editorStatus,
  filterWorkflows,
  importRefusal,
  inUseText,
  initialEditor,
} from '../web/src/components/workflows/workflows-model.js';

const entry = (over: Partial<WorkflowLibraryEntry> = {}): WorkflowLibraryEntry => ({
  name: 'docs-only',
  description: '',
  subject: 'ticket',
  version: 2,
  inUse: { tickets: 0, running: 0, workspaces: 0 },
  assignedAs: [],
  ...over,
});

describe('workflows library model', () => {
  it('filters by name only and ignores case', () => {
    const list = [entry({ name: 'Default' }), entry({ name: 'security-review', description: 'lint things' })];
    expect(filterWorkflows(list, 'DEFA').map((e) => e.name)).toEqual(['Default']);
    expect(filterWorkflows(list, 'lint')).toEqual([]);
    expect(filterWorkflows(list, '  ')).toHaveLength(2);
  });

  it('pluralises the in-use summary', () => {
    expect(inUseText({ tickets: 41, workspaces: 5 })).toBe('in use by 41 Tickets / 5 Workspaces');
    expect(inUseText({ tickets: 1, workspaces: 1 })).toBe('in use by 1 Ticket / 1 Workspace');
  });

  it('renders a neutral placeholder when nothing is assigned', () => {
    expect(assignedChips(entry())).toEqual([{ tone: 'neutral', text: 'Not assigned' }]);
  });

  it('renders assignments by kind', () => {
    const chips = assignedChips(
      entry({ assignedAs: [{ kind: 'global-default' }, { kind: 'workspace-default', label: 'harmonic' }, { kind: 'label', label: 'docs' }] }),
    );
    expect(chips.map((c) => c.text)).toEqual(['Global default', 'Workspace default · harmonic', 'Workflow Label · docs']);
  });

  it('explains why Delete is blocked', () => {
    expect(deleteBlock(entry({ name: 'implement' }))).toContain('Fallback workflow');
    expect(deleteBlock(entry({ inUse: { tickets: 41, running: 0, workspaces: 5 } }))).toBe('In use by 41 Tickets and 5 Workspaces.');
    expect(deleteBlock(entry({ inUse: { tickets: 2, running: 0, workspaces: 0 }, assignedAs: [{ kind: 'label', label: 'security' }] }))).toBe('In use by 2 Tickets and 1 Workflow Label.');
    expect(deleteBlock(entry())).toBeNull();
  });

  it('words an import refusal with the first issue position', () => {
    const err = new ApiError(400, 'invalid', 'validation', null, [{ message: 'unknown key retries', line: 9, column: 5 }]);
    expect(importRefusal('docs-only.yaml', err)).toBe('Import refused: docs-only.yaml\nLine 9, col 5: unknown key retries. Nothing was added to the library.');
    expect(importRefusal('x.yaml', new ApiError(409, 'A workflow named x already exists'))).toBe('Import refused: x.yaml\nA workflow named x already exists. Nothing was added to the library.');
  });
});

describe('workflow editor state', () => {
  const base = initialEditor('name: a\n', 4);
  const issues = [
    { message: 'bad', line: 2, column: 3 },
    { message: 'worse', line: 5, column: 1 },
    { message: 'worst', line: 6, column: 1 },
  ];

  it('walks saved, edited, saving, errors', () => {
    expect(editorStatus(base)).toMatchObject({ status: 'saved', pill: 'Saved', saveLabel: 'Save', saveDisabled: true });
    const edited = editorReducer(base, { type: 'edit', text: 'name: b\n' });
    expect(editorStatus(edited)).toMatchObject({ status: 'edited', pill: 'Edited', saveLabel: 'Save as v5', saveDisabled: false });
    const saving = editorReducer(edited, { type: 'saving' });
    expect(editorStatus(saving)).toMatchObject({ status: 'saving', pill: 'Saving…', saveLabel: 'Saving…', saveDisabled: true });
    const refused = editorReducer(saving, { type: 'refused', issues });
    expect(editorStatus(refused)).toMatchObject({ status: 'errors', pill: '3 errors', saveLabel: 'Save · 3 errors', saveDisabled: true });
  });

  it('keeps errors and Save disabled after a refusal until the text changes, then allows a retry', () => {
    const refused = editorReducer(editorReducer(editorReducer(base, { type: 'edit', text: 'x' }), { type: 'saving' }), { type: 'refused', issues });
    expect(refused.issues).toHaveLength(3);
    const retry = editorReducer(refused, { type: 'edit', text: 'xy' });
    expect(retry.issues).toEqual([]);
    expect(editorStatus(retry).saveDisabled).toBe(false);
  });

  it('adopts the saved version and clears edits', () => {
    const saved = editorReducer(editorReducer(base, { type: 'edit', text: 'name: b\n' }), { type: 'saved', text: 'name: b\n', version: 5 });
    expect(editorStatus(saved)).toMatchObject({ status: 'saved', saveLabel: 'Save' });
    expect(saved.version).toBe(5);
  });

  it('reverting to the saved text counts as saved', () => {
    expect(editorStatus(editorReducer(editorReducer(base, { type: 'edit', text: 'z' }), { type: 'edit', text: 'name: a\n' })).status).toBe('saved');
  });

  it('uses singular for one error', () => {
    const one = editorReducer(editorReducer(editorReducer(base, { type: 'edit', text: 'q' }), { type: 'saving' }), { type: 'refused', issues: [issues[0]!] });
    expect(editorStatus(one).pill).toBe('1 error');
  });
});
