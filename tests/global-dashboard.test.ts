// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GlobalDashboard } from '../web/src/components/GlobalDashboard.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const stats = (cost: number) => ({
  from: 0, to: Date.now(), attemptCount: 2, attemptsByState: {}, failedAttempts: 0,
  failuresByReason: {}, durationMs: null, totals: { inputTokens: 30, outputTokens: 15, cacheReadTokens: 9, cacheWriteTokens: 6, totalTokens: 60 },
  models: {}, toolCalls: {}, cost: { totalUsd: cost, byModel: {}, incomplete: false }, series: [],
  byWorkspace: [
    { workspaceId: 1, name: 'Main', color: '#123456', cost: { totalUsd: cost, byModel: {}, incomplete: false }, inputTokens: 20, outputTokens: 10, cacheReadTokens: 6, cacheWriteTokens: 4, tasks: 1, failureRate: 0 },
    { workspaceId: 2, name: 'Other', color: '#654321', cost: { totalUsd: 2, byModel: {}, incomplete: false }, inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, tasks: 1, failureRate: 0 },
  ],
  verdicts: { critic: { pass: 0, block: 0, inconclusive: 0 }, command: { pass: 0, block: 0, inconclusive: 0 } },
  gateOutcomes: { autoMerged: 0, escalated: 0, revertedOnRed: 0 }, guardrailTrips: {}, tasksMergedByDay: [], attemptsPerTask: { '1': 0, '2': 0, '3': 0, '4+': 0 }, costPerMergedTask: { mergedTasks: 0, mergedCost: null, wastedCost: null },
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove(); root = null; host = null; vi.unstubAllGlobals();
});

it('renders the global roll-up, token bars, workspace totals, and drill-ins', async () => {
  const navigate = vi.fn();
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const path = String(input);
    if (path.includes('/api/stats')) return new Response(JSON.stringify(stats(path.includes('604800000') ? 21 : 12)));
    if (path === '/api/tasks?limit=100&offset=0') return new Response(JSON.stringify({ total: 2, tasks: [{ id: 1, workspaceId: 1, state: 'escalated' }, { id: 2, workspaceId: 2, state: 'working' }] }));
    if (path === '/api/activity') return new Response(JSON.stringify({ processes: [{ workspaceId: 1, type: 'attempt' }, { workspaceId: 2, type: 'chat' }] }));
    return new Response(JSON.stringify({}));
  });
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(GlobalDashboard, { pendingPermissions: 1, hostLoad: null, onNavigate: navigate }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(host.textContent).toContain('Needs you');
  expect(host.textContent).toContain('Tokens today');
  expect(host.textContent).toContain('Workspaces');
  expect(host.querySelector('[aria-label="Tokens by workspace"]')).not.toBeNull();
  expect(host.textContent).not.toContain('Total tokens');
  const buttons = [...host.querySelectorAll('button')];
  await act(async () => { buttons.slice(0, 3).forEach((button) => button.click()); });
  expect(navigate).toHaveBeenNthCalledWith(1, 'table');
  expect(navigate).toHaveBeenNthCalledWith(2, 'activity');
  expect(navigate).toHaveBeenNthCalledWith(3, 'stats');
  expect(host.textContent).toContain('Total');
  expect(host.textContent).toContain('Cache hit');
});
