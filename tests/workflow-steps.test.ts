// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupByAttempt, WorkflowSteps } from '../web/src/components/ticket/WorkflowSteps.js';
import { Properties } from '../web/src/components/ticket/Metrics.js';
import type { WorkflowStepRun, WorkflowStepsResponse } from '../web/src/types.js';
import { cleanup, makeTask, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

function step(overrides: Partial<WorkflowStepRun>): WorkflowStepRun {
  return {
    stepId: 's1',
    action: 'run',
    position: 0,
    attempt: null,
    outcome: 'pass',
    summary: null,
    resolvedPrompt: null,
    outputs: { stdout: '', exitCode: 0 },
    startedAt: 1,
    endedAt: 2,
    ...overrides,
  };
}

const response = (steps: WorkflowStepRun[]): WorkflowStepsResponse => ({ workflowRef: 'implement@2', workflowChosen: 'explicit', outline: [], cleanupCount: 0, latestVersion: null, steps });

describe('WorkflowSteps', () => {
  it('groups steps under their Attempt number', async () => {
    const host = await mountComponent(createElement(WorkflowSteps, { data: response([step({ stepId: 'rebase' }), step({ stepId: 'build', attempt: 1, outcome: 'fail' }), step({ stepId: 'build', attempt: 2 })]) }));
    const headings = [...host.querySelectorAll('h4')].map((h) => h.textContent);
    expect(headings).toEqual(['Attempt 1', 'Attempt 2']);
  });

  it('gives every group a distinct position when steps surround the block', () => {
    const groups = groupByAttempt([step({ stepId: 'rebase' }), step({ stepId: 'build', attempt: 1 }), step({ stepId: 'build', attempt: 2 }), step({ stepId: 'merge' })]);
    expect(groups.map((g) => [g.attempt, g.firstIndex])).toEqual([[null, 0], [1, 1], [2, 2], [null, 3]]);
  });

  it('shows a step skipped by if: as skipped', async () => {
    const host = await mountComponent(createElement(WorkflowSteps, { data: response([step({ stepId: 'maybe', outcome: 'skipped', summary: 'if: false was false', outputs: { stdout: '', exitCode: null } })]) }));
    expect(host.textContent).toContain('skipped');
    expect(host.querySelector('[role="img"][aria-label="skipped"]')).not.toBeNull();
    expect(host.textContent).not.toContain('no exit code');
  });

  it('renders nothing without a workflowRef', async () => {
    const host = await mountComponent(createElement(WorkflowSteps, { data: { workflowRef: null, workflowChosen: null, outline: [], cleanupCount: 0, latestVersion: null, steps: [] } }));
    expect(host.innerHTML).toBe('');
    const empty = await mountComponent(createElement(WorkflowSteps, { data: null }));
    expect(empty.innerHTML).toBe('');
  });

  it('lists pass, fail and running steps with id, action, outcome and outputs', async () => {
    const host = await mountComponent(
      createElement(WorkflowSteps, {
        data: response([
          step({ stepId: 'build', action: 'run', outputs: { stdout: 'compiling\nok\n', exitCode: 0 } }),
          step({ stepId: 'check', action: 'command', position: 1, outcome: 'fail', summary: 'exit 1', outputs: { stdout: 'boom', exitCode: 1 } }),
          step({ stepId: 'later', action: 'run', position: 2, outcome: null, endedAt: null, outputs: { stdout: '', exitCode: null } }),
        ]),
      }),
    );
    const rows = [...host.querySelectorAll('li')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('build');
    expect(rows[0]!.textContent).toContain('run');
    expect(rows[0]!.querySelector('[role="img"][aria-label="passed"]')).not.toBeNull();
    expect(rows[0]!.textContent).toContain('exit 0 · 2 lines · last: ok');
    expect(rows[1]!.textContent).toContain('command');
    expect(rows[1]!.querySelector('[role="img"][aria-label="failed"]')).not.toBeNull();
    expect(rows[1]!.textContent).toContain('1boom');
    expect(rows[1]!.textContent).toContain('exit 1 · 1 line · last: boom');
    expect(rows[2]!.querySelector('[role="img"][aria-label="running"]')).not.toBeNull();
    expect(rows[2]!.textContent).not.toContain('exit');
    expect(host.textContent).toContain('implement v2');
  });

  it('shows an agent step\'s Resolved Prompt and none for other steps', async () => {
    const host = await mountComponent(
      createElement(WorkflowSteps, { data: response([step({ stepId: 'build', action: 'agent', resolvedPrompt: 'Do the thing' }), step({ stepId: 'lint', position: 1 })]) }),
    );
    const rows = [...host.querySelectorAll('li')];
    expect(rows[0]!.querySelector('details details summary')?.textContent).toBe('Resolved Prompt');
    expect(rows[0]!.querySelector('details pre')?.textContent).toBe('Do the thing');
    expect(rows[1]!.querySelector('details details')).toBeNull();
  });

  it('renders a re-run step as a second row without duplicate keys', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = await mountComponent(
      createElement(WorkflowSteps, {
        data: response([
          step({ stepId: 'build', outcome: null, endedAt: null }),
          step({ stepId: 'build', startedAt: 1, endedAt: 2 }),
        ]),
      }),
    );
    expect(host.querySelectorAll('li')).toHaveLength(2);
    expect(errors.mock.calls.flat().join(' ')).not.toContain('same key');
    errors.mockRestore();
  });
});

describe('Properties workflow row', () => {
  it('shows name, version and how it was chosen', async () => {
    const host = await mountComponent(
      createElement(Properties, { task: makeTask({ workflowRef: 'implement@2', workflowChosen: 'explicit' }), allTasks: [], workspaceName: 'ws' }),
    );
    expect(host.textContent).toContain('Workflow');
    expect(host.textContent).toContain('implement');
    expect(host.textContent).toContain('v2');
    expect(host.textContent).toContain('operator choice on this Ticket');
  });

  it('omits the row when no workflow is pinned', async () => {
    const host = await mountComponent(createElement(Properties, { task: makeTask(), allTasks: [], workspaceName: 'ws' }));
    expect(host.textContent).not.toContain('Workflow');
  });
});
