import { describe, expect, it } from 'vitest';
import { attemptRows, defaultOpenKey, eventsForStepRun, passNumbers, passTone, rowSummary } from '../web/src/step-run-model.js';
import type { AttemptLogEvent, StepRun } from '../web/src/types.js';

let seq = 0;
const run = (over: Partial<StepRun>): StepRun => ({
  id: ++seq, attemptId: 1, stepId: 's', action: 'run', kind: 'check', pass: 1, position: 0, state: 'pass', outcome: 'pass', summary: null, detail: null, condition: null,
  outputs: { stdout: '', exitCode: 0 }, hasPrompt: false, sessionRowId: null, harness: null, model: null, cost: null, startedAt: 100, endedAt: 200, ...over,
});
const workflow = { outline: ['rebase', 'implement', 'verify', 'merge'].map((id) => ({ id, children: [] as string[] })), cleanupIds: [] as string[] };

describe('step run model', () => {
  it('lists the selected Pass plus out-of-block runs, then pending outline steps; verify markers hide unless failed', () => {
    const runs = [
      run({ stepId: 'rebase', kind: 'rebase', pass: null }),
      run({ stepId: 'implement', kind: 'agent', pass: 1 }),
      run({ stepId: 'implement', kind: 'agent', pass: 2 }),
      run({ stepId: 'mark', kind: 'marker', pass: 2 }),
    ];
    const rows = attemptRows({ stepRuns: runs, pass: 2, workflow, showPending: true });
    expect(rows.map((r) => `${r.stepId}${r.run ? '' : ':pending'}`)).toEqual(['rebase', 'implement', 'verify:pending', 'merge:pending']);
    expect(attemptRows({ stepRuns: runs, pass: 2, workflow, showPending: false })).toHaveLength(2);
  });

  it('opens the running row, else the failed row, else the last agent row', () => {
    const agent = run({ stepId: 'a', kind: 'agent' });
    const failed = run({ stepId: 'v', state: 'fail', outcome: 'fail' });
    const running = run({ stepId: 'r', state: 'running', outcome: null, endedAt: null });
    const keyOf = (runs: StepRun[]) => defaultOpenKey(attemptRows({ stepRuns: runs, pass: 1, workflow: null, showPending: false }));
    expect(keyOf([agent, failed, running])).toBe(`run:${running.id}`);
    expect(keyOf([agent, failed])).toBe(`run:${failed.id}`);
    expect(keyOf([agent, run({ stepId: 'ok' })])).toBe(`run:${agent.id}`);
  });

  it('tones Passes and numbers them', () => {
    const runs = [run({ pass: 1, state: 'fail', outcome: 'fail' }), run({ pass: 2, state: 'running', outcome: null }), run({ pass: 3 })];
    expect(passNumbers(runs)).toEqual([1, 2, 3]);
    expect([1, 2, 3].map((n) => passTone(runs, n))).toEqual(['fail', 'running', 'pass']);
  });

  it('reads an interrupted step as interrupted, not failed', () => {
    const interrupted = run({ state: 'interrupted', outcome: null, summary: 'interrupted by process death' });
    expect(rowSummary(interrupted)).toBe('interrupted');
    expect(attemptRows({ stepRuns: [interrupted], pass: 1, workflow: null, showPending: false })[0]?.run?.state).toBe('interrupted');
  });

  it('prefers the stepRunId tag, falling back to the run window for untagged events', () => {
    const ev = (over: Partial<AttemptLogEvent>): AttemptLogEvent => ({ id: 1, seq: 1, ts: 150, type: 'session_update', payload: { sessionUpdate: 'x' }, ...over });
    const target = { id: 7, startedAt: 100, endedAt: null };
    const events = [ev({ id: 1, stepRunId: 7 }), ev({ id: 2, stepRunId: 8 }), ev({ id: 3 }), ev({ id: 4, ts: 50 })];
    expect(eventsForStepRun(events, target).map((e) => e.id)).toEqual([1, 3]);
  });
});
