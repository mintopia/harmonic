// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatsPage } from '../web/src/components/StatsPage.js';
import { dayKey } from '../web/src/components/costChart-model.js';
import type { Stats } from '../web/src/stats-model.js';

const DAY_MS = 24 * 3600_000;

function makeStats(overrides: Partial<Stats> = {}): Stats {
  return {
    from: 0,
    to: Date.now(),
    attemptCount: 0,
    attemptsByState: {},
    failedAttempts: 0,
    failuresByReason: {},
    durationMs: null,
    totals: null,
    models: {},
    toolCalls: {},
    cost: null,
    series: [],
    byWorkspace: [],
    verdicts: {
      critic: { pass: 0, block: 0, inconclusive: 0 },
      command: { pass: 0, block: 0, inconclusive: 0 },
    },
    gateOutcomes: { autoMerged: 0, escalated: 0, revertedOnRed: 0 },
    guardrailTrips: {},
    tasksMergedByDay: [],
    attemptsPerTask: { '1': 0, '2': 0, '3': 0, '4+': 0 },
    costPerMergedTask: { mergedTasks: 0, mergedCost: null, wastedCost: null },
    ...overrides,
  };
}

function stubStatsFetch(build: () => Response) {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith('/api/stats')) return build();
    return new Response(JSON.stringify({}));
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderPage(workspaceId: number | null): Promise<HTMLDivElement> {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(StatsPage, { workspaceId }));
    await flush();
  });
  return host;
}

describe('StatsPage smoke (issue #452)', () => {
  it('renders the header and a loading card with no workspace, and skips the heatmap', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('fetch should not be called when workspaceId is null');
    });

    await renderPage(null);

    expect(host!.textContent).toContain('Usage & statistics');
    expect(host!.textContent).toContain('Loading…');
    expect(host!.textContent).not.toContain('Attempt activity');
  });

  it('shows the error state when the stats fetch fails', async () => {
    stubStatsFetch(() => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }));

    await renderPage(1);

    expect(host!.textContent).toContain('Couldn’t load statistics: boom');
  });

  it('shows the empty state when attemptCount is zero', async () => {
    stubStatsFetch(() => new Response(JSON.stringify(makeStats({ attemptCount: 0 }))));

    await renderPage(1);

    expect(host!.textContent).toContain('No attempts to chart yet');
  });

  it('renders the populated dashboard sections', async () => {
    const now = Date.now();
    const stats = makeStats({
      attemptCount: 42,
      attemptsByState: { completed: 30, cancelled: 2 },
      failedAttempts: 10,
      totals: { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 300, cacheWriteTokens: 100, totalTokens: 3400 },
      cost: { totalUsd: 12.34, byModel: { 'claude-3-opus': 12.34 }, incomplete: false },
      models: {
        'claude-3-opus': { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 300, cacheWriteTokens: 100 },
      },
      toolCalls: { bash: 12, read: 5 },
      series: [
        { day: dayKey(now - DAY_MS), totalUsd: 4, incomplete: false, tokens: 500, attempts: 5, fails: 1 },
        { day: dayKey(now), totalUsd: 8, incomplete: false, tokens: 900, attempts: 8, fails: 2 },
      ],
      byWorkspace: [
        {
          workspaceId: 1,
          name: 'Main',
          cost: { totalUsd: 12.34, byModel: {}, incomplete: false },
          inputTokens: 1000,
          outputTokens: 2000,
          tasks: 5,
          failureRate: 0.2,
        },
      ],
    });
    stubStatsFetch(() => new Response(JSON.stringify(stats)));

    await renderPage(1);

    const headings = [...host!.querySelectorAll('h2')].map((h) => h.textContent);
    expect(host!.textContent).toContain('Cost · 7 days');
    expect(host!.textContent).toContain('Attempts');
    expect(headings).toContain('Reliability');
    expect(headings).toContain('Tokens & cost per model');
    expect(headings).toContain('Where the spend goes');
  });

  it('renders the time-range segmented control and toggles selection', async () => {
    stubStatsFetch(() => new Response(JSON.stringify(makeStats())));

    await renderPage(1);

    const group = host!.querySelector('[aria-label="Time range"]');
    const buttons = [...(group?.querySelectorAll('button') ?? [])];
    expect(buttons.map((b) => b.textContent)).toEqual(['24 hours', '7 days', '30 days', 'All time']);
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      buttons[0]!.click();
      await flush();
    });

    const updated = host!.querySelector('[aria-label="Time range"] button');
    expect(updated?.getAttribute('aria-pressed')).toBe('true');
  });
});
