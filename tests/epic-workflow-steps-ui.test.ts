// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowSteps } from '../web/src/components/ticket/WorkflowSteps.js';
import { preCutoverAttempts } from '../web/src/epic-attempt-history-model.js';
import type { EpicAttempt, WorkflowStepRun, WorkflowStepsResponse } from '../web/src/types.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

const step = (stepId: string, attempt: number, outcome: WorkflowStepRun['outcome'], startedAt = 100): WorkflowStepRun => ({
  stepId, action: 'run', position: 0, attempt, outcome, summary: null, resolvedPrompt: null, outputs: { stdout: '', exitCode: 0 }, startedAt, endedAt: startedAt + 1,
});

const response = (steps: WorkflowStepRun[], extra: Partial<WorkflowStepsResponse> = {}): WorkflowStepsResponse => ({
  workflowRef: 'epic@1', workflowChosen: 'workspace', outline: [], cleanupCount: 0, latestVersion: 1, steps, ...extra,
});
const epicAttempt = (number: number, startedAt: number, state: EpicAttempt['state'] = 'passed') => ({ id: number, number, state, startedAt }) as EpicAttempt;

describe('Epic step list', () => {
  const steps = [step('resolve', 1, 'skipped'), step('verify', 1, 'fail'), step('resolve', 2, 'pass'), step('verify', 2, 'pass')];

  it('selects the latest Attempt and switches on click', async () => {
    const host = await mountComponent(createElement(WorkflowSteps, { data: response(steps), attemptSelector: true }));
    const chips = [...host.querySelectorAll('[aria-label="Attempt"] button')];
    expect(chips.map((c) => c.textContent)).toEqual(['Attempt 1', 'Attempt 2']);
    expect(chips[1]!.getAttribute('aria-pressed')).toBe('true');
    expect([...host.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['Attempt 2']);
    await act(async () => (chips[0] as HTMLButtonElement).click());
    expect([...host.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['Attempt 1ended on verify: fail, next Attempt started']);
    expect(host.querySelector('[role="img"][aria-label="skipped"]')).not.toBeNull();
    expect(host.querySelector('[role="img"][aria-label="failed"]')).not.toBeNull();
  });

  it('shows the bound, per-step chips, a Parallel label, numbered failing lines and unstarted steps', async () => {
    const failing = { ...step('verify', 2, 'fail'), outputs: { stdout: '$ npm test\nFAIL a.test.ts\nok', exitCode: 1 } };
    const data = response([step('resolve', 1, 'pass'), failing], {
      maxAttempts: 3,
      cleanupCount: 1,
      cleanupIds: ['cleanup'],
      blockStepIds: ['resolve', 'verify', 'correctness'],
      outline: [{ id: 'resolve', children: [] }, { id: 'verify', children: [] }, { id: 'review', children: ['correctness'] }, { id: 'merge', children: [] }],
      stepInfo: {
        resolve: { uses: 'agent', detail: 'prompt epic-resolve', condition: 'attempt.number > 1' },
        verify: { uses: 'command', detail: 'npm test', condition: null },
        correctness: { uses: 'critic', detail: 'claude-opus-5-5', condition: null },
        merge: { uses: 'merge', detail: null, condition: null },
        cleanup: { uses: 'cleanup', detail: null, condition: null },
      },
    });
    const host = await mountComponent(createElement(WorkflowSteps, { data, attemptSelector: true }));
    expect(host.querySelector('h4')?.textContent).toBe('Attempt 2 of 3ended on verify: fail');
    expect(host.textContent).toContain('Attempt 3 has not started');
    expect(host.textContent).toContain('agent · prompt epic-resolve');
    expect(host.textContent).toContain('if: attempt.number > 1');
    expect(host.textContent).toContain('critic · claude-opus-5-5');
    expect(host.textContent?.toLowerCase()).toContain('parallel');
    expect(host.querySelectorAll('[role="img"][aria-label="not started"]').length).toBe(5);
    const bad = [...host.querySelectorAll('.whitespace-pre')].filter((el) => el.textContent === 'FAIL a.test.ts' && el.parentElement?.className.includes('bg-fail-tint'));
    expect(bad).toHaveLength(1);
    expect(host.textContent).toContain('Cleanup');
  });

  it('keeps pre-cutover Attempts out of the live run', () => {
    const attempts = [epicAttempt(1, 10), epicAttempt(2, 20), epicAttempt(3, 90, 'running')];
    expect(preCutoverAttempts(attempts, steps, 'epic@1').map((a) => a.number)).toEqual([1, 2]);
    expect(preCutoverAttempts(attempts, [], null).map((a) => a.number)).toEqual([1, 2, 3]);
    expect(preCutoverAttempts(attempts, [], 'epic@1').map((a) => a.number)).toEqual([1, 2]);
  });
});
