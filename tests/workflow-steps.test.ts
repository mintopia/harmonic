// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Properties } from '../web/src/components/ticket/Metrics.js';
import { ExecutionRow } from '../web/src/components/ticket/TargetParts.js';
import { cleanup, makeTask, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

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

describe('execution target UI', () => {
  it('shows the pod facts and the deleted caption', async () => {
    const execution = { target: 'k8s-prod', podName: 'p-1', podState: 'deleted' as const, namespace: 'ns', image: 'img:1', source: 'step' as const };
    const host = await mountComponent(createElement(ExecutionRow, { execution, branch: 'harmonic/task-1', agent: null }));
    expect(host.textContent).toContain('from step runs_on');
    expect(host.textContent).toContain('Pod deleted');
    expect(host.textContent).toContain('per-pod Secret are gone');
    expect(host.textContent).toContain('harmonic/task-1');
    const plain = await mountComponent(createElement(Properties, { task: makeTask({ execution }), allTasks: [], workspaceName: null }));
    expect(plain.textContent).not.toContain('Namespace');
  });
});
