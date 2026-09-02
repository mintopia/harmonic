// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { StatsPanel } from '../web/src/components/ticket/StatsPanel.js';
import { Verification } from '../web/src/components/ticket/Verification.js';
import type { AttemptSummary, VerificationAttempt, VerifierStatus } from '../web/src/types.js';
import type { TaskStats } from '../web/src/task-detail-model.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

const run: AttemptSummary = {
  id: 1,
  taskId: 1,
  number: 1,
  state: 'completed',
  reason: null,
  stopReason: null,
  sessionId: null,
  prompt: null,
  branch: null,
  baseBranch: null,
  usage: null,
  cost: null,
  startedAt: 0,
  finishedAt: 1,
};

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

  it('renders a command verification result separately from TicketPage', async () => {
    const statuses: VerifierStatus[] = [{ mechanism: 'command', state: 'passed', reason: null, commands: ['npm test'] }];
    const attempts: VerificationAttempt[] = [{
      id: 1,
      attemptId: 1,
      seq: 1,
      ts: 1,
      mechanism: 'command',
      inputOid: 'abc',
      verdict: 'pass',
      summary: 'All tests passed.',
      output: '',
      prompt: null,
      hasTranscript: false,
    }];
    const host = await mountComponent(createElement(Verification, { attempts, statuses, run }));

    expect(host.textContent).toContain('Verification');
    expect(host.textContent).toContain('proceed');
    expect(host.textContent).toContain('npm test');
    expect(host.textContent).toContain('All tests passed.');
  });
});
