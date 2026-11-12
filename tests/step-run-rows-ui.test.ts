// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('dompurify', () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));
vi.mock('../web/src/api.js', () => ({
  api: {
    stepRunLog: vi.fn().mockResolvedValue({ status: 'unavailable', liveCursor: 0 }),
    stepRunPrompt: vi.fn().mockResolvedValue('the prompt'),
    stepRunOutputUrl: (id: number) => `/api/step-runs/${id}/output`,
    attemptResolvedPrompts: vi.fn().mockResolvedValue([]),
    resolvedPrompt: vi.fn().mockResolvedValue(''),
    steerTask: vi.fn(),
  },
}));

import { AttemptPanel, OutlineSteps } from '../web/src/components/ticket/AttemptPanel.js';
import type { Attempt, AttemptSummary, StepRun, WorkflowStepsResponse } from '../web/src/types.js';
import { taskStats } from '../web/src/task-detail-model.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(cleanup);

let seq = 0;
const step = (over: Partial<StepRun>): StepRun => ({
  id: ++seq, attemptId: 1, stepId: 's', action: 'run', kind: 'check', pass: 1, position: 0, state: 'pass', outcome: 'pass', summary: null, detail: null, condition: null,
  outputs: { stdout: '', exitCode: 0 }, hasPrompt: false, sessionRowId: null, harness: null, model: null, cost: null, startedAt: 100, endedAt: 200, ...over,
});
const run: AttemptSummary = { pullRequestUrl: null, id: 1, taskId: 1, number: 1, state: 'running', reason: null, stopReason: null, sessionId: null, prompt: null, branch: null, baseBranch: null, usage: null, cost: null, startedAt: 0, finishedAt: null };
const workflow: WorkflowStepsResponse = {
  workflowRef: 'implement@1', workflowChosen: 'explicit', cleanupCount: 0, latestVersion: 1, steps: [], maxAttempts: 3, cleanupIds: [],
  outline: ['implement', 'verify', 'merge'].map((id) => ({ id, children: [] })),
  stepInfo: { implement: { uses: 'agent', detail: null, condition: null }, verify: { uses: 'run', detail: 'npm test', condition: null }, merge: { uses: 'open-pr', detail: null, condition: null } },
};

const mount = (stepRuns: StepRun[], over: Partial<Parameters<typeof AttemptPanel>[0]> = {}) =>
  mountComponent(createElement(AttemptPanel, {
    run, attempt: { stepRuns } as Attempt, snapshot: undefined, stats: taskStats([]), events: [], following: false, onToggleFollow: () => {},
    guardrailEvents: [], workflow, showPending: false, primaryModel: 'claude', agent: 'Claude', ...over,
  }));

describe('Attempt step list', () => {
  it('opens the failed check with its command, numbered log and full-output link', async () => {
    const host = await mount([step({ stepId: 'verify', state: 'fail', outcome: 'fail', detail: 'npm test', outputs: { stdout: 'ok\nAssertionError: x', exitCode: 1 } })]);
    expect(host.textContent).toContain('npm test');
    expect(host.textContent).toContain('AssertionError: x');
    expect(host.querySelector('a[href^="/api/step-runs/"]')?.textContent).toBe('Full output');
    expect(host.textContent).toContain('fail');
  });

  it('shows a Pass selector only when more than one Pass ran, and switches Pass', async () => {
    const one = await mount([step({ stepId: 'verify', pass: 1 })]);
    expect(one.querySelector('[role="group"][aria-label="Pass"]')).toBeNull();
    await cleanup();
    const host = await mount([step({ stepId: 'first', pass: 1, state: 'fail', outcome: 'fail' }), step({ stepId: 'second', pass: 2 })]);
    expect(host.textContent).toContain('second');
    expect(host.textContent).not.toContain('first');
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Pass"] button')!.click(); });
    expect(host.textContent).toContain('first');
    expect(host.textContent).not.toContain('second');
  });

  it('renders unrun outline steps as pending rows while the Attempt is current', async () => {
    const host = await mount([step({ stepId: 'implement', kind: 'agent', action: 'agent', state: 'running', outcome: null, endedAt: null })], { showPending: true });
    const pending = [...host.querySelectorAll('li')].filter((li) => li.textContent?.includes('pending'));
    expect(pending.map((li) => li.textContent)).toEqual([expect.stringContaining('verify'), expect.stringContaining('merge')]);
  });

  it('shows an interrupted step as interrupted, not running or failed', async () => {
    const host = await mount([step({ stepId: 'verify', state: 'interrupted', outcome: null })]);
    expect(host.textContent).toContain('interrupted');
    expect(host.querySelector('[aria-label="interrupted"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="running"]')).toBeNull();
    expect(host.querySelector('[aria-label="failed"]')).toBeNull();
  });

  it('shows a Ticket with no Attempt as its workflow outline, all pending', async () => {
    const host = await mountComponent(createElement(OutlineSteps, { workflow }));
    expect([...host.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      expect.stringContaining('implement'), expect.stringContaining('verify'), expect.stringContaining('merge'),
    ]);
    expect(host.querySelectorAll('[aria-label="not started"]')).toHaveLength(3);
  });
});
