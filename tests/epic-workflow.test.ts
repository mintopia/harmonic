import { describe, expect, it } from 'vitest';
import { loadBaselineConfig } from '../src/config.js';
import { resolveEpicWorkflow, resolveWorkflow } from '../src/domain/workflow-assignment.js';
import { workflowReferenceProblems } from '../src/domain/workflow-labels.js';
import { WorkflowLibrary } from '../src/domain/workflow-library-store.js';
import { parseWorkflow } from '../src/domain/workflow.js';

const base = loadBaselineConfig();
const config = (epicWorkflow: string | null = null, workflow: string | null = null) => ({ ...base, defaults: { ...base.defaults, epicWorkflow, workflow } });

describe('resolveEpicWorkflow', () => {
  it('prefers the Workspace Epic workflow, then the global one, then the bundled epic', () => {
    expect(resolveEpicWorkflow({ epicWorkflow: 'mine' }, config('shared'), () => true)).toEqual({ name: 'mine', chosen: 'workspace' });
    expect(resolveEpicWorkflow({ epicWorkflow: null }, config('shared'), () => true)).toEqual({ name: 'shared', chosen: 'global' });
    expect(resolveEpicWorkflow(null, config(), () => true)).toEqual({ name: 'epic', chosen: 'global' });
  });
  it('skips a name the library no longer holds', () => {
    expect(resolveEpicWorkflow({ epicWorkflow: 'gone' }, config('shared'), (n) => n !== 'gone')).toEqual({ name: 'shared', chosen: 'global' });
    expect(resolveEpicWorkflow({ epicWorkflow: 'gone' }, config('also-gone'), (n) => n === 'epic')).toEqual({ name: 'epic', chosen: 'global' });
  });
});

describe('bundled epic workflow', () => {
  const library = new WorkflowLibrary(null);
  it('parses with subject epic and the ticket workflows stay tickets', () => {
    const entry = library.get('epic');
    expect(entry.subject).toBe('epic');
    expect(entry.bundled).toBe(true);
    expect(parseWorkflow(entry.text).subject).toBe('epic');
    expect(library.get('implement').subject).toBe('ticket');
  });
  it('runs the critic unconditionally', () => {
    const text = library.get('epic').text;
    expect(text).toMatch(/- id: critic\n\s+uses: critic/);
    expect(text).not.toContain('vars.review');
    expect(text).not.toMatch(/id: critic[\s\S]*?\n\s+if:/);
  });
});

describe('subject validation', () => {
  const library = new WorkflowLibrary(null);
  it('refuses a ticket workflow as an Epic workflow', () => {
    expect(workflowReferenceProblems(library, { epicWorkflow: 'implement' })[0]).toMatch(/epicWorkflow.*not an Epic workflow/);
    expect(workflowReferenceProblems(library, { epicWorkflow: 'epic' })).toEqual([]);
  });
  it('refuses an epic workflow as a ticket workflow or Workflow Label target', () => {
    expect(workflowReferenceProblems(library, { workflow: 'epic' })[0]).toMatch(/workflow.*Epic workflow/);
    expect(workflowReferenceProblems(library, { labels: [{ label: 'bug', workflow: 'epic' }] })[0]).toMatch(/workflowLabels\.0/);
    expect(workflowReferenceProblems(library, { overlay: [{ kind: 'local', workflowLabel: { label: 'bug', workflow: 'epic' } } as never] })[0]).toMatch(/workflowLabels\.0/);
  });
  it('never resolves a ticket to an epic-subject workflow', () => {
    const cfg = config(null, 'epic');
    expect(resolveWorkflow({ requested: null, trackerLabels: null, workspace: { workflow: 'epic' }, config: cfg, exists: (n) => n !== 'epic' }).name).toBe('implement');
  });
});
