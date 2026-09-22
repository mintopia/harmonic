// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EpicTimeline } from '../web/src/components/EpicTimeline.js';
import { LifecycleTimeline } from '../web/src/components/ticket/LifecycleTimeline.js';
import { epicTimelineRows } from '../web/src/epic-timeline-model.js';
import type { Epic } from '../web/src/epic-model.js';
import type { TicketTimelineEvent } from '../web/src/types.js';

const TASK_TIMELINE_EVENTS = [
  { attemptId: 1, ts: 2_000, kind: 'attempt-started', data: { attempt: 1 } },
] satisfies TicketTimelineEvent[];

function epic(): Epic {
  return {
    ref: 701,
    title: 'Timeline',
    kind: 'spec',
    state: 'integrated',
    description: '',
    createdAt: 1_000,
    updatedAt: null,
    baseBranch: 'develop',
    dependsOn: [],
    members: [],
    ready: [],
    integration: { branch: 'epic/701', exists: false, tip: 'abcdef123' },
    verification: { status: 'pass', configured: true },
    integrate: { inFlight: false, held: null },
    mergeSteps: [
      { step: 'started', baseBranch: 'develop', taskBranch: 'epic/701' },
      { step: 'merged', mergeOid: 'abcdef123' },
      { step: 'retired', branch: 'epic/701', baseBranch: 'develop' },
    ],
    timelineEvents: [
      { seq: 2, at: 3_000, step: { step: 'merged', mergeOid: 'abcdef123' } },
      { seq: 1, at: 2_000, step: { step: 'started', baseBranch: 'develop', taskBranch: 'epic/701' } },
      { seq: 3, at: 4_000, step: { step: 'retired', branch: 'epic/701', baseBranch: 'develop' } },
    ],
    foldedCount: 0,
    memberCount: 0,
    inPlace: false,
  };
}

describe('EpicTimeline', () => {
  it('orders lifecycle, integration, and retirement events chronologically', () => {
    expect(epicTimelineRows(epic()).map((row) => row.label)).toEqual([
      'Epic created',
      'Merge started',
      'Merged',
      'Integration branch retired',
    ]);
  });

  it('renders the epic events as a task-detail-style chronological timeline', () => {
    const html = renderToStaticMarkup(createElement(EpicTimeline, { epic: epic() }));
    const taskHtml = renderToStaticMarkup(createElement(LifecycleTimeline, { events: TASK_TIMELINE_EVENTS, following: false, onToggleFollow: () => {} }));

    expect(html).toContain('aria-label="Chronological epic timeline"');
    for (const layoutClass of ['py-5', 'mb-4 text-title font-semibold text-ink', 'flex items-baseline gap-2.5', 'grid-cols-[64px_minmax(0,1fr)]', 'border-l border-hairline', 'ring-4 ring-surface']) {
      expect(html).toContain(layoutClass);
      expect(taskHtml).toContain(layoutClass);
    }
    expect(html.indexOf('Epic created')).toBeLessThan(html.indexOf('Merge started'));
    expect(html.indexOf('Merge started')).toBeLessThan(html.indexOf('Merged'));
    expect(html.indexOf('Merged')).toBeLessThan(html.indexOf('Integration branch retired'));
  });

  it('renders a "Completed in place" row for an in-place Epic, detailed with the base branch', () => {
    const rows = epicTimelineRows({
      ...epic(),
      inPlace: true,
      timelineEvents: [{ seq: 1, at: 2_000, step: { step: 'completed-in-place', baseBranch: 'develop' } }],
    });
    expect(rows.map((row) => row.label)).toEqual(['Epic created', 'Completed in place']);
    expect(rows[1]).toMatchObject({ detail: 'develop', tone: 'passed' });
  });
});
