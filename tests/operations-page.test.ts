import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OperationRow, OperationsPage } from '../web/src/components/OperationsPage.js';
import { WorktreesTable } from '../web/src/components/WorktreeInventoryView.js';
import type { WorktreeInventoryEntry } from '../web/src/worktree-inventory-model.js';
import { ScheduledJobsTable } from '../web/src/components/ScheduledJobsView.js';
import type { Operation } from '../web/src/operations-model.js';

const operation = (attributes: Record<string, unknown>): Operation => ({
  type: 'attempt',
  name: 'harmonic.attempt',
  traceId: 'trace-1',
  spanId: 'span-1',
  parentSpanId: null,
  attributes,
  startedAt: 1_000,
  endedAt: null,
  status: { code: 0, message: null },
  children: [],
});

describe('OperationsPage', () => {
  it('renders the worktree inventory controls and state-specific actions', () => {
    const worktrees: WorktreeInventoryEntry[] = [
      { id: 'dirty', workspaceId: 1, path: '/worktrees/task-1', branch: 'harmonic/task-1', subject: { kind: 'task', taskId: 1, title: 'Dirty task' }, sizeBytes: 1_572_864, dirty: true, changeCount: 3, state: 'Dirty' },
      { id: 'stale', workspaceId: 1, path: '/worktrees/task-2', branch: 'harmonic/task-2', subject: null, sizeBytes: 512, dirty: false, changeCount: 0, state: 'Stale' },
    ];
    const html = renderToStaticMarkup(createElement(WorktreesTable, {
      worktrees,
      busyId: null,
      onOpenTask: () => {},
      onClean: () => {},
      onForceCleanup: () => {},
    }));

    for (const header of ['Worktree', 'Branch', 'Subject', 'State', 'Changes', 'Size', 'Actions']) {
      expect(html).toContain(`>${header}<`);
    }
    expect(html).toContain('>Dirty<');
    expect(html).toContain('>task-1<');
    expect(html).toContain('harmonic/task-1');
    expect(html).toContain('Task 1: Dirty task');
    expect(html).toContain('>3 uncommitted<');
    expect(html).toContain('>Clean<');
    expect(html).toContain('1.5 MB');
    expect(html).toContain('>Open</button>');
    expect(html).toContain('>Force cleanup</button>');
    expect(html).toContain('>Clean now</button>');
  });

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

  it('links a live operation to its owning Task title and states what it is doing', () => {
    const root = operation({ 'task.id': 7, 'task.title': 'Fix live operation subjects' });
    root.children = [operation({})];
    const html = renderToStaticMarkup(createElement(OperationRow, {
      operation: root,
      now: 2_000,
      depth: 0,
      onOpenTask: () => {},
    }));

    expect(html.match(/>Fix live operation subjects<\/button>/g)).toHaveLength(2);
    expect(html).toContain('>Working on this Task</span>');
  });

  it('links a live operation to its owning Epic title', () => {
    const html = renderToStaticMarkup(createElement(OperationRow, {
      operation: operation({ 'epic.ref': 24, 'epic.title': 'Live operations refinement' }),
      now: 2_000,
      depth: 0,
      onOpenEpic: () => {},
    }));

    expect(html).toContain('>Live operations refinement</button>');
  });

  it('uses the loaded Task title for operations recorded before title metadata', () => {
    const html = renderToStaticMarkup(createElement(OperationRow, {
      operation: operation({ 'task.id': 7 }),
      now: 2_000,
      depth: 0,
      tasks: [{ id: 7, summary: 'Fix live operation subjects' }],
      onOpenTask: () => {},
    }));

    expect(html).toContain('>Fix live operation subjects</button>');
  });
});
