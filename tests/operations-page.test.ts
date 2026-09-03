import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OperationsPage } from '../web/src/components/OperationsPage.js';
import { ScheduledJobsTable } from '../web/src/components/ScheduledJobsView.js';

describe('OperationsPage', () => {
  it('provides independent labelled slots for scheduled jobs and live spans', () => {
    const html = renderToStaticMarkup(
      createElement(OperationsPage, {
        scheduledJobs: createElement('p', null, 'scheduled-jobs-slot'),
        spanTree: createElement('p', null, 'span-tree-slot'),
      }),
    );

    expect(html).toContain('<h1');
    expect(html).toContain('>Operations</h1>');
    expect(html).toContain('aria-labelledby="scheduled-jobs-heading"');
    expect(html).toContain('scheduled-jobs-slot');
    expect(html).toContain('aria-labelledby="span-tree-heading"');
    expect(html).toContain('span-tree-slot');
  });

  it('renders scheduled jobs as a compact read-only strip', () => {
    const html = renderToStaticMarkup(
      createElement(ScheduledJobsTable, {
        now: 2_000,
        jobs: [{
          jobKey: 'tracker:2', name: 'Tracker poll', workspaceId: 2, intervalMs: 60_000,
          status: 'disabled', lastRunAt: 1_000, lastStatus: 'error', lastDurationMs: 500,
          lastError: 'Tracker will not resolve', lastOperationSpanId: null, nextRunAt: null,
        }],
      }),
    );

    for (const header of ['Name', 'Cadence', 'Next run', 'Result']) {
      expect(html).toContain(`>${header}<`);
    }
    expect(html).toContain('60s');
    expect(html).toContain('—');
    expect(html).toContain('Error');
    expect(html).not.toContain('Scope');
    expect(html).not.toContain('Last run');
    expect(html).not.toContain('Last duration');
    expect(html).not.toContain('Status');
    expect(html).not.toContain('Operation');
    expect(html).not.toContain('Workspace');
    expect(html).toContain('<dt class="sr-only">Cadence</dt>');
    expect(html).toContain('aria-label="Error: Tracker will not resolve"');
    expect(html).toContain('title="Tracker will not resolve"');
    expect(html).not.toContain('Disabled');
    expect(html).not.toContain('<button');
  });
});
