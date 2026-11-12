// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { StatsPanel } from '../web/src/components/ticket/StatsPanel.js';
import type { TaskStats } from '../web/src/task-detail-model.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

const stats: TaskStats = {
  byModel: [{ model: 'codex', input: 100, output: 50, cachedIn: 0, cachedOut: 0, cost: 0.02 }],
  agentVsSubagent: { agentTokens: 150, subagentTokens: 0 },
  costByModel: [{ model: 'codex', cost: 0.02 }],
  billableIO: 150,
  cost: 0.02,
  subagents: 0,
  agents: 1,
  toolCalls: 3,
  toolTokens: [],
};

describe('ticket panel components (issue #465)', () => {
  it('renders populated stats separately from TicketPage', async () => {
    const host = await mountComponent(createElement(StatsPanel, { stats }));

    expect(host.textContent).toContain('Token breakdown by model');
    expect(host.textContent).toContain('codex');
    expect(host.textContent).toContain('$0.02');
  });
});
