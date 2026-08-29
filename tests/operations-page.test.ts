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

  it('renders the read-only scheduled jobs table with failing and disabled jobs distinct', () => {
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

    for (const header of ['Name', 'Scope', 'Interval', 'Last run', 'Last duration', 'Result', 'Next run', 'Status', 'Operation']) {
      expect(html).toContain(`>${header}<`);
    }
    expect(html).toContain('Workspace');
    expect(html).toContain('Error');
    expect(html).toContain('Tracker will not resolve');
    expect(html).toContain('Disabled');
    expect(html).not.toContain('<button');
  });
});
