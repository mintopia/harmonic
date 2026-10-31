// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorkflow } from '../src/domain/workflow.js';
import { buildWorkflowDiagram } from '../src/domain/workflow-diagram.js';
import { WorkflowDiagram } from '../web/src/components/WorkflowDiagram.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

const model = buildWorkflowDiagram(
  parseWorkflow(`name: w
description: d
steps:
  - id: rebase
    uses: rebase
  - attempts:
      max: 2
      steps:
        - id: build
          uses: agent
  - id: merge
    uses: merge
`),
);

describe('WorkflowDiagram', () => {
  it('lists the steps and reports a matching editor', async () => {
    const container = await mountComponent(createElement(WorkflowDiagram, { model, stale: false, errorCount: 0 }));
    expect(container.querySelector('[aria-label="Workflow step diagram"]')).not.toBeNull();
    expect(container.textContent).toContain('Live diagram');
    expect(container.textContent).toContain('Matches the editor');
    expect(container.textContent).toContain('read-only');
    for (const label of ['rebase', 'build', 'merge', 'Escalation']) expect(container.textContent).toContain(label);
  });

  it('dims and explains a stale diagram', async () => {
    const container = await mountComponent(createElement(WorkflowDiagram, { model, stale: true, errorCount: 3 }));
    expect(container.textContent).toContain('Stale');
    expect(container.textContent).toContain('Showing last valid parse. Fix the 3 errors to refresh the diagram.');
    expect(container.querySelector('[data-stale="true"]')).not.toBeNull();
  });
});
